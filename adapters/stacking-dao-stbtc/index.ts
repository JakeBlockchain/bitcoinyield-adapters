import { defineAdapter, http, stacks } from "@bitcoinyield/adapters";
import {
  APP,
  CORE,
  DATA,
  HIRO,
  RESERVE,
  SBTC_ASSET,
  TOKEN,
} from "./constants.js";
import {
  buildMetrics,
  bulkCreditTransactions,
  rewardCreditIds,
  stateDeltasAfterCutoff,
  summarizeCredits,
  uintValue,
} from "./helpers.js";
import type { AssetEvent, ContractLogEvent } from "./helpers.js";

const SHARE_SCALE = 100000000n;
const TRAILING_WINDOW_SECONDS = 30 * 86400;
const EVENT_PAGE_SIZE = 50;

interface HiroBlock {
  height: number;
  blockTime: number;
}

interface HiroContractEvent {
  event_type?: string;
  contract_log?: {
    value?: {
      repr?: string;
    };
  };
}

interface HiroBalances {
  fungible_tokens?: Record<string, { balance?: string }>;
}

function finiteInteger(value: unknown, name: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw new Error(`Invalid ${name}: ${String(value)}`);
  }
  return number;
}

function parseBlock(raw: unknown, requestedHeight?: number): HiroBlock {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Hiro block");
  const value = raw as { height?: unknown; block_time?: unknown };
  return {
    height: finiteInteger(value.height ?? requestedHeight, "block height"),
    blockTime: finiteInteger(value.block_time, "block time"),
  };
}

async function getBlock(height: number): Promise<HiroBlock> {
  return parseBlock(
    await http.get<unknown>(`${HIRO}/extended/v2/blocks/${height}`),
    height,
  );
}

async function getLatestBlock(): Promise<HiroBlock> {
  return parseBlock(
    await http.get<unknown>(`${HIRO}/extended/v2/blocks/latest`),
  );
}

/** Find the last Stacks block at or before the requested timestamp. */
async function findHistoricalBlock(
  latest: HiroBlock,
  targetTime: number,
): Promise<HiroBlock> {
  let lowHeight = Math.max(1, latest.height - 500000);
  let low = await getBlock(lowHeight);
  let high = latest;

  // Widen the lower bound only if the chain has been unusually slow.
  while (low.blockTime > targetTime && low.height > 1) {
    high = low;
    lowHeight = Math.max(1, lowHeight - 500000);
    low = await getBlock(lowHeight);
  }
  if (low.blockTime > targetTime) {
    throw new Error("Could not bracket the trailing APY cutoff block");
  }

  let best = low;
  for (let i = 0; i < 16 && high.height - low.height > 1; i++) {
    const timeSpan = high.blockTime - low.blockTime;
    const estimated =
      timeSpan > 0
        ? Math.round(
            low.height +
              ((targetTime - low.blockTime) * (high.height - low.height)) /
                timeSpan,
          )
        : Math.floor((low.height + high.height) / 2);
    const candidateHeight = Math.max(
      low.height + 1,
      Math.min(high.height - 1, estimated),
    );
    const candidate = await getBlock(candidateHeight);
    if (candidate.blockTime <= targetTime) {
      best = candidate;
      low = candidate;
    } else {
      high = candidate;
    }
  }
  return best;
}

function parseContractEvent(raw: HiroContractEvent): ContractLogEvent | null {
  const repr = raw.contract_log?.value?.repr;
  if (raw.event_type !== "smart_contract_log" || typeof repr !== "string")
    return null;
  const action = /\(action \"([^\"]+)\"\)/.exec(repr)?.[1];
  const blockHeightText = /\(block-height u(\d+)\)/.exec(repr)?.[1];
  if (!action || !blockHeightText) return null;
  const data: Record<string, bigint> = {};
  for (const match of repr.matchAll(/\(([a-z][a-z0-9-]*) u(\d+)\)/g)) {
    const key = match[1];
    const value = match[2];
    if (key && value) data[key] = BigInt(value);
  }
  return {
    blockHeight: Number(blockHeightText),
    action,
    data,
  };
}

/** Read deployed print events; the endpoint is paginated newest-first. */
async function getContractEvents(
  contract: string,
  cutoffHeight: number,
): Promise<ContractLogEvent[]> {
  const events: ContractLogEvent[] = [];
  for (let offset = 0; ; offset += EVENT_PAGE_SIZE) {
    const page = await http.get<{ results?: HiroContractEvent[] }>(
      `${HIRO}/extended/v1/contract/${contract}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`,
    );
    const results = Array.isArray(page.results) ? page.results : [];
    if (results.length === 0) break;
    let reachedCutoff = false;
    for (const raw of results) {
      const event = parseContractEvent(raw);
      if (!event) continue;
      if (event.blockHeight > cutoffHeight) events.push(event);
      else reachedCutoff = true;
    }
    if (reachedCutoff || results.length < EVENT_PAGE_SIZE) break;
  }
  return events;
}

function historicalSbtcBalance(balances: HiroBalances): bigint {
  const tokens = balances.fungible_tokens;
  if (!tokens) throw new Error("Hiro returned no fungible-token balances");
  const shortAsset = SBTC_ASSET.split("::")[0];
  for (const [asset, entry] of Object.entries(tokens)) {
    if (asset === SBTC_ASSET || asset === shortAsset) {
      return uintValue(entry.balance);
    }
  }
  throw new Error("Historical reserve sBTC balance is missing");
}

async function reconstructHistoricalRatio(
  cutoff: HiroBlock,
  current: {
    staked: bigint;
    reserved: bigint;
    supply: bigint;
    pending: bigint;
  },
) {
  const [reserveEvents, coreEvents, balanceResponse] = await Promise.all([
    getContractEvents(RESERVE, cutoff.height),
    getContractEvents(CORE, cutoff.height),
    http.get<HiroBalances>(
      `${HIRO}/extended/v1/address/${RESERVE}/balances?until_block=${cutoff.height}`,
    ),
  ]);
  const deltas = stateDeltasAfterCutoff(
    [...reserveEvents, ...coreEvents],
    cutoff.height,
  );
  const historicalStaked = current.staked - deltas.staked;
  const historicalReserved = current.reserved - deltas.reserved;
  const historicalSupply = current.supply - deltas.supply;
  const historicalPending = current.pending - deltas.pending;
  const historicalIdle = historicalSbtcBalance(balanceResponse);
  const historicalTotal = historicalIdle + historicalStaked;
  if (
    historicalStaked < 0n ||
    historicalReserved < 0n ||
    historicalSupply <= 0n ||
    historicalPending < 0n ||
    historicalPending >= historicalSupply ||
    historicalTotal <= 0n ||
    historicalReserved >= historicalTotal
  ) {
    throw new Error("Historical stBTC accounting did not reconcile");
  }
  const activeBacking = historicalTotal - historicalReserved;
  const activeSupply = historicalSupply - historicalPending;
  const historicalRatio = (activeBacking * SHARE_SCALE) / activeSupply;
  if (historicalRatio <= 0n)
    throw new Error("Historical stBTC ratio is invalid");
  return {
    historicalRatio,
    historicalTotal,
    historicalIdle,
    historicalStaked,
    historicalReserved,
    historicalSupply,
    historicalPending,
    eventCounts: {
      reserve: reserveEvents.length,
      core: coreEvents.length,
    },
  };
}

export default defineAdapter({
  slug: "stacking-dao-stbtc",
  name: "Stacking DAO stBTC",
  url: APP,
  category: "yield-bearing",
  custody: "multisig",
  requires: { stacks: true },

  async fetch() {
    const latestBlock = await getLatestBlock();
    const cutoff = await findHistoricalBlock(
      latestBlock,
      latestBlock.blockTime - TRAILING_WINDOW_SECONDS,
    );
    const reads = [
      [RESERVE, "get-total-sbtc"],
      [RESERVE, "get-sbtc-staking"],
      [RESERVE, "get-sbtc-for-withdrawals"],
      [TOKEN, "get-total-supply"],
      [DATA, "get-pending-shares"],
      [DATA, "get-sbtc-per-stbtc"],
    ] as const;
    const values = await Promise.all(
      reads.map(async ([contract, functionName]) =>
        uintValue(await stacks.callReadOnly({ contract, functionName })),
      ),
    );
    const [total, staked, reserved, supply, pending, ratio] = values as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    if (staked > total)
      throw new Error("stBTC staked principal exceeds reserve TVL");
    const historical = await reconstructHistoricalRatio(cutoff, {
      staked,
      reserved,
      supply,
      pending,
    });
    const row = buildMetrics({
      total,
      staked,
      idle: total - staked,
      reserved,
      supply,
      pending,
      ratio,
      historicalRatio: historical.historicalRatio,
      elapsedSeconds: latestBlock.blockTime - cutoff.blockTime,
    });

    // Optional history must never turn an unavailable observation into zero.
    let compounding: Record<string, unknown>;
    try {
      const assets = await http.get<{ results: AssetEvent[]; total: number }>(
        `${HIRO}/extended/v1/address/${RESERVE}/assets?limit=50`,
      );
      if (!Array.isArray(assets.results))
        throw new Error("Missing reserve asset events");
      const ids = rewardCreditIds(assets.results).slice(0, 20);
      const bulk = ids.length
        ? await http.get<unknown>(
            `${HIRO}/extended/v1/tx/multiple?${ids.map((id) => `tx_id=${encodeURIComponent(id)}`).join("&")}`,
          )
        : {};
      const transactions = bulkCreditTransactions(ids, bulk);
      compounding = {
        ...summarizeCredits(transactions),
        status: "observed",
        sampleDefinition:
          "up to 20 unique reward-credit transactions in latest 50 reserve asset events; not a fixed time window",
        assetEventsScanned: assets.results.length,
        historyTruncated:
          assets.total > assets.results.length ||
          rewardCreditIds(assets.results).length > ids.length,
      };
    } catch (error) {
      compounding = {
        status: "unavailable",
        creditCount: null,
        medianIntervalSeconds: null,
        lastCreditAt: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return [
      {
        ...row,
        metadata: {
          ...row.metadata,
          currentBlockHeight: latestBlock.height,
          currentBlockTime: new Date(
            latestBlock.blockTime * 1000,
          ).toISOString(),
          historicalBlockHeight: cutoff.height,
          historicalBlockTime: new Date(cutoff.blockTime * 1000).toISOString(),
          historicalTotalSbtc: Number(historical.historicalTotal) / 1e8,
          historicalIdleSbtc: Number(historical.historicalIdle) / 1e8,
          historicalStakedSbtc: Number(historical.historicalStaked) / 1e8,
          historicalReservedForWithdrawalsSbtc:
            Number(historical.historicalReserved) / 1e8,
          historicalStbtcSupply: Number(historical.historicalSupply) / 1e8,
          historicalPendingStbtcShares:
            Number(historical.historicalPending) / 1e8,
          historicalEventCounts: historical.eventCounts,
          compounding,
          observedAt: new Date().toISOString(),
        },
      },
    ];
  },
});
