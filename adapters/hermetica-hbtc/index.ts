/**
 * Hermetica hBTC adapter — on-chain Stacks reads.
 *
 * TVL: `get-total-assets` on the state contract (sats held by the vault).
 * APY: 30-day compounded share-price growth. The controller logs one
 *      `log-reward` tx per day, and each commits the vault's new share price
 *      (net of fees, with losses flagged `is-positive false` applied) in a
 *      `commit-reward` print event. The baseline is the price committed by
 *      the earliest log-reward inside the window; the latest is
 *      `get-share-price` as of `get-last-log-ts`. A losing window comes out
 *      negative and is published as-is.
 */

import {
  defineAdapter,
  http,
  math,
  requirePositive,
  stacks,
} from "@bitcoinyield/adapters";

const DEPLOYER = "SP1S1HSFH0SQQGWKB69EYFNY0B1MHRMGXR3J1FH4D";
const STATE_CONTRACT = `${DEPLOYER}.state-hbtc-v1`;
const CONTROLLER_CONTRACT = `${DEPLOYER}.controller-hbtc-v1`;

const HIRO_API = "https://api.hiro.so";
const APY_WINDOW_DAYS = 30;
// One log-reward lands per day; a much shorter observed window means a Hiro
// indexing gap, and annualizing it would overweight a few days.
const MIN_WINDOW_DAYS = 25;
const SECONDS_PER_DAY = 86_400;

interface HiroTxPage {
  results: Array<{
    tx: {
      tx_id: string;
      tx_status: string;
      burn_block_time_iso: string;
      contract_call?: { function_name: string };
    };
  }>;
}

interface HiroTx {
  events: Array<{
    contract_log?: { contract_id: string; value: { repr: string } };
  }>;
}

const PAGE_SIZE = 50;
const MAX_TX_PAGES = 4;

/**
 * Earliest successful log-reward tx since the cutoff. Paginates: a busy
 * month of unrelated controller txs can push the window's start past the
 * first page. Results are newest-first, so the last match wins.
 */
async function findWindowStartTx(
  cutoffMs: number,
): Promise<{ txId: string; rewardTxCount: number }> {
  let txId: string | null = null;
  let rewardTxCount = 0;
  for (let page = 0; page < MAX_TX_PAGES; page++) {
    const txPage = await http.get<HiroTxPage>(
      `${HIRO_API}/extended/v2/addresses/${CONTROLLER_CONTRACT}/transactions` +
        `?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
    );
    let pastCutoff = false;
    for (const { tx } of txPage.results) {
      if (new Date(tx.burn_block_time_iso).getTime() < cutoffMs) {
        pastCutoff = true;
        continue;
      }
      if (tx.tx_status !== "success") continue;
      if (tx.contract_call?.function_name !== "log-reward") continue;
      txId = tx.tx_id;
      rewardTxCount += 1;
    }
    if (pastCutoff || txPage.results.length < PAGE_SIZE) break;
  }
  if (!txId) {
    throw new Error(
      `Hermetica: no log-reward txs in the last ${APY_WINDOW_DAYS}d`,
    );
  }
  return { txId, rewardTxCount };
}

/** Share price (raw, 8 decimals) and log timestamp a log-reward tx committed. */
async function readCommittedSharePrice(
  txId: string,
): Promise<{ sharePriceRaw: number; logTs: number }> {
  const tx = await http.get<HiroTx>(`${HIRO_API}/extended/v1/tx/${txId}`);
  const repr = tx.events.find(
    (e) =>
      e.contract_log?.contract_id === STATE_CONTRACT &&
      e.contract_log.value.repr.includes('(action "commit-reward")'),
  )?.contract_log?.value.repr;
  const sharePrice = repr?.match(/\(share-price \(tuple \(new u(\d+)\)/)?.[1];
  const logTs = repr?.match(/\(log-ts u(\d+)\)/)?.[1];
  if (!sharePrice || !logTs) {
    throw new Error(`Hermetica: no commit-reward share price in tx ${txId}`);
  }
  return {
    sharePriceRaw: requirePositive(Number(sharePrice), "committed share-price"),
    logTs: Number(logTs),
  };
}

export default defineAdapter({
  slug: "hermetica-hbtc",
  name: "Hermetica hBTC",
  url: "https://app.hermetica.fi",
  category: "yield-bearing",
  custody: "multisig",
  requires: { stacks: true },

  async fetch() {
    const cutoffMs = Date.now() - APY_WINDOW_DAYS * SECONDS_PER_DAY * 1000;
    const [totalAssetsRaw, sharePriceRaw, lastLogTsRaw, windowStart] =
      await Promise.all([
        stacks.callReadOnly({
          contract: STATE_CONTRACT,
          functionName: "get-total-assets",
        }),
        stacks.callReadOnly({
          contract: STATE_CONTRACT,
          functionName: "get-share-price",
        }),
        stacks.callReadOnly({
          contract: STATE_CONTRACT,
          functionName: "get-last-log-ts",
        }),
        findWindowStartTx(cutoffMs),
      ]);

    const totalAssetsSats = requirePositive(
      Number(totalAssetsRaw),
      "get-total-assets",
    );
    const sharePriceNowRaw = requirePositive(
      Number(sharePriceRaw),
      "get-share-price",
    );
    const baseline = await readCommittedSharePrice(windowStart.txId);

    const windowDays =
      (Number(lastLogTsRaw) - baseline.logTs) / SECONDS_PER_DAY;
    if (windowDays < MIN_WINDOW_DAYS) {
      throw new Error(
        `Hermetica: share-price window is only ${windowDays.toFixed(1)}d ` +
          `(need ${MIN_WINDOW_DAYS}d+) — refusing to annualize a partial window`,
      );
    }

    const apy = math.mul(
      math.sub(
        Math.pow(
          math.div(sharePriceNowRaw, baseline.sharePriceRaw),
          365 / windowDays,
        ),
        1,
      ),
      100,
    );

    return [
      {
        symbol: "hBTC",
        tvlBtc: math.fromUnits(totalAssetsSats, 8),
        rate: apy,
        rateType: "apy",
        metadata: {
          stateContract: STATE_CONTRACT,
          controllerContract: CONTROLLER_CONTRACT,
          sharePrice: math.fromUnits(sharePriceNowRaw, 8),
          sharePriceThen: math.fromUnits(baseline.sharePriceRaw, 8),
          baselineTxId: windowStart.txId,
          rewardTxCount: windowStart.rewardTxCount,
          windowDays,
          rateSource: "onchain-30d-share-price-apy",
        },
      },
    ];
  },
});
