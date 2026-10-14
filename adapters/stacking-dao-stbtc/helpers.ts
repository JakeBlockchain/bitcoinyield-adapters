import { math, requireNumber, requirePositive } from "@bitcoinyield/adapters";
import type { AdapterResult } from "@bitcoinyield/adapters";
import { APP, RESERVE, REWARDS, SBTC_ASSET } from "./constants.js";

const SECONDS_PER_DAY = 86400;
const DAYS_PER_YEAR = 365;

export function uintValue(value: unknown): bigint {
  if (typeof value === "object" && value !== null && "value" in value) {
    const v = value as { type?: unknown; value: unknown };
    if (v.type === "err") throw new Error("Clarity response-err");
    return uintValue(v.value);
  }
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error("Expected a nonnegative Clarity uint");
}

export interface Snapshot {
  total: bigint;
  idle: bigint;
  staked: bigint;
  reserved: bigint;
  supply: bigint;
  pending: bigint;
  ratio: bigint;
  historicalRatio: bigint;
  elapsedSeconds: number;
}

/**
 * Annualize the compounded change in the on-chain sBTC/stBTC exchange rate.
 * Preserve the compounded convention in the framework's explicit rate type.
 */
export function trailingApyFromRates(
  currentRate: bigint,
  historicalRate: bigint,
  elapsedSeconds: number,
): number {
  if (currentRate <= 0n || historicalRate <= 0n) {
    throw new Error("Exchange rates must be positive");
  }
  if (
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds <= 0 ||
    elapsedSeconds > 366 * SECONDS_PER_DAY
  ) {
    throw new Error("Trailing APY window must be a positive finite duration");
  }
  const growth = math.div(currentRate, historicalRate, undefined);
  const annualization = (DAYS_PER_YEAR * SECONDS_PER_DAY) / elapsedSeconds;
  return requireNumber(
    (Math.pow(growth, annualization) - 1) * 100,
    "stbtc.trailingApy",
  );
}

export function buildMetrics(s: Snapshot): AdapterResult {
  if (
    s.total <= 0n ||
    s.total !== s.idle + s.staked ||
    s.reserved >= s.total ||
    s.pending >= s.supply
  ) {
    throw new Error("Invalid stBTC reserve/share accounting");
  }
  const backing = s.total - s.reserved;
  const activeSupply = s.supply - s.pending;
  const expectedRatio = (backing * 100000000n) / activeSupply;
  const ratioDifference =
    expectedRatio > s.ratio ? expectedRatio - s.ratio : s.ratio - expectedRatio;
  // Reads are latest-state calls, not an atomic snapshot. Fail on material drift.
  if (s.ratio <= 0n || ratioDifference > 100n)
    throw new Error("stBTC ratio does not reconcile with backing");
  const trailingApy = trailingApyFromRates(
    s.ratio,
    s.historicalRatio,
    s.elapsedSeconds,
  );
  return {
    symbol: "stBTC",
    tvlBtc: requirePositive(math.fromUnits(s.total, 8), "stbtc.tvlBtc"),
    rate: trailingApy,
    rateType: "apy",
    metadata: {
      ...(trailingApy === 0 ? { allowZeroRate: true } : {}),
      rateSource: "onchain-30d-sbtc-per-stbtc-apy",
      rateBasis: "realized-exchange-rate-growth",
      rateWindow: "trailing-30d",
      rateWindowDays: s.elapsedSeconds / SECONDS_PER_DAY,
      rateWindowSeconds: s.elapsedSeconds,
      apySource: "Stacks mainnet on-chain exchange-rate history via Hiro",
      apyEvidenceStatus: "independently-derived-on-chain",
      rewardAsset: "sBTC",
      yieldPayer: "Stacks protocol bond/PoX rewards",
      tvlDefinition:
        "gross sBTC reserve balance plus staked principal; includes withdrawal reserves",
      tvlSource: `${RESERVE}.get-total-sbtc`,
      stakedSbtc: math.fromUnits(s.staked, 8),
      idleSbtc: math.fromUnits(s.idle, 8),
      reservedForWithdrawalsSbtc: math.fromUnits(s.reserved, 8),
      activeBackingSbtc: math.fromUnits(backing, 8),
      stbtcSupply: math.fromUnits(s.supply, 8),
      pendingStbtcShares: math.fromUnits(s.pending, 8),
      activeStbtcSupply: math.fromUnits(activeSupply, 8),
      sbtcPerStbtc: math.fromUnits(s.ratio, 8),
      historicalSbtcPerStbtc: math.fromUnits(s.historicalRatio, 8),
      trailingApy,
      appUrl: APP,
    },
  };
}

export interface ContractLogEvent {
  blockHeight: number;
  action: string;
  data: Record<string, bigint>;
}

export interface StateDeltas {
  /** Change in total stBTC supply after the cutoff. */
  supply: bigint;
  /** Change in pending withdrawal shares after the cutoff. */
  pending: bigint;
  /** Change in reserve staked principal after the cutoff. */
  staked: bigint;
  /** Change in sBTC reserved for withdrawals after the cutoff. */
  reserved: bigint;
}

function eventValue(event: ContractLogEvent, key: string): bigint {
  return event.data[key] ?? 0n;
}

/**
 * Convert deployed contract `print` events after a historical cutoff into
 * signed state deltas. This lets the adapter reconstruct the historical
 * exchange rate without relying on a website's derived APY endpoint.
 */
export function stateDeltasAfterCutoff(
  events: ContractLogEvent[],
  cutoffHeight: number,
): StateDeltas {
  const deltas: StateDeltas = {
    supply: 0n,
    pending: 0n,
    staked: 0n,
    reserved: 0n,
  };
  for (const event of events) {
    if (
      !Number.isFinite(event.blockHeight) ||
      event.blockHeight <= cutoffHeight
    )
      continue;
    switch (event.action) {
      case "deposit":
        deltas.supply += eventValue(event, "stbtc-amount");
        break;
      case "withdraw-idle":
        deltas.supply -= eventValue(event, "stbtc-amount");
        break;
      case "withdraw":
        deltas.supply -= eventValue(event, "stbtc-amount");
        deltas.pending -= eventValue(event, "stbtc-amount");
        break;
      case "init-withdraw":
        deltas.pending += eventValue(event, "stbtc-amount");
        break;
      case "request-sbtc-to-stack":
        deltas.staked += eventValue(event, "requested-sbtc");
        break;
      case "return-sbtc-from-stacking":
        deltas.staked -= eventValue(event, "sbtc-amount");
        break;
      case "lock-sbtc-for-withdrawal":
        deltas.reserved += eventValue(event, "sbtc-amount");
        break;
      case "unlock-sbtc-from-withdrawal":
        deltas.reserved -= eventValue(event, "sbtc-amount");
        break;
      case "request-sbtc-for-withdrawal":
        deltas.reserved -= eventValue(event, "requested-sbtc");
        deltas.pending -= eventValue(event, "stbtc-amount");
        break;
      default:
        break;
    }
  }
  return deltas;
}

export interface AssetEvent {
  tx_id: string;
  event_type: string;
  asset: {
    asset_event_type: string;
    asset_id: string;
    sender?: string;
    recipient?: string;
    amount?: string;
  };
}

export function rewardCreditIds(events: AssetEvent[]): string[] {
  return [
    ...new Set(
      events
        .filter(
          (e) =>
            e.event_type === "fungible_token_asset" &&
            e.asset.asset_event_type === "transfer" &&
            e.asset.asset_id === SBTC_ASSET &&
            e.asset.sender === REWARDS &&
            e.asset.recipient === RESERVE &&
            uintValue(e.asset.amount) > 0n,
        )
        .map((e) => e.tx_id),
    ),
  ];
}

export interface CreditTransaction {
  tx_id: string;
  block_time?: number;
  tx_status: string;
  canonical: boolean;
  microblock_canonical?: boolean;
}

export function summarizeCredits(transactions: CreditTransaction[]) {
  const confirmed = [
    ...new Map(
      transactions
        .filter(
          (t) =>
            t.canonical === true &&
            t.microblock_canonical !== false &&
            t.tx_status === "success" &&
            typeof t.block_time === "number" &&
            Number.isFinite(t.block_time) &&
            t.block_time > 0,
        )
        .map((t) => [t.tx_id, t]),
    ).values(),
  ];
  const times = confirmed.map((t) => t.block_time!).sort((a, b) => b - a);
  const intervals = times
    .slice(1)
    .map((t, i) => times[i]! - t)
    .sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median =
    intervals.length === 0
      ? null
      : intervals.length % 2
        ? intervals[mid]!
        : math.div(math.add(intervals[mid - 1]!, intervals[mid]!), 2);
  return {
    creditCount: times.length,
    lastCreditAt: times.length
      ? new Date(times[0]! * 1000).toISOString()
      : null,
    lastCreditTxId:
      confirmed.find((t) => t.block_time === times[0])?.tx_id ?? null,
    medianIntervalSeconds: median,
    sampleSpanSeconds:
      times.length >= 2 ? times[0]! - times[times.length - 1]! : null,
    sampleStartAt: times.length
      ? new Date(times[times.length - 1]! * 1000).toISOString()
      : null,
    mechanism:
      "sBTC credits from rewards-pox5-v1 to stbtc-reserve; nested calls included",
    interpretation:
      "observed reward-credit cadence, not guaranteed reinvestment cadence",
    releaseWindowBitcoinBlocks: 2100,
  };
}

export function bulkCreditTransactions(
  ids: string[],
  response: unknown,
): CreditTransaction[] {
  if (!response || typeof response !== "object")
    throw new Error("Invalid bulk transaction response");
  const entries = response as Record<
    string,
    { found?: boolean; result?: CreditTransaction }
  >;
  return ids.map((id) => {
    const entry = entries[id];
    if (entry?.found !== true || !entry.result || entry.result.tx_id !== id) {
      throw new Error(`Missing sampled reward transaction ${id}`);
    }
    return entry.result;
  });
}
