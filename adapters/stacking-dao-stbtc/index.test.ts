import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize } from "@bitcoinyield/adapters";
import adapter from "./index.js";
import {
  buildMetrics,
  bulkCreditTransactions,
  stateDeltasAfterCutoff,
  rewardCreditIds,
  summarizeCredits,
  trailingApyFromRates,
  uintValue,
} from "./helpers.js";

const snapshot = {
  total: 63796953488n,
  idle: 496953488n,
  staked: 63300000000n,
  reserved: 308967195n,
  supply: 63639662108n,
  pending: 308248642n,
  ratio: 100247227n,
  historicalRatio: 100117349n,
  elapsedSeconds: 2592005,
};

test("annualizes on-chain exchange-rate growth as a trailing compounded APY", () => {
  const apy = trailingApyFromRates(100247227n, 100117349n, 2592005);
  assert.ok(Math.abs(apy - 1.5898093752) < 1e-9);
  assert.equal(trailingApyFromRates(100000000n, 100000000n, 30 * 86400), 0);
  assert.throws(() => trailingApyFromRates(0n, 100000000n, 30 * 86400));
  assert.throws(() => trailingApyFromRates(100000000n, 0n, 30 * 86400));
  assert.throws(() => trailingApyFromRates(100000000n, 100000000n, 0));
});

test("decodes uint and response-ok without accepting missing or invalid reads", () => {
  assert.equal(uintValue("63300000000"), 63300000000n);
  assert.equal(uintValue({ type: "uint", value: "63300000000" }), 63300000000n);
  assert.equal(
    uintValue({ type: "ok", value: { type: "uint", value: "63300000000" } }),
    63300000000n,
  );
  for (const v of [
    undefined,
    null,
    -1,
    1.5,
    "",
    "NaN",
    { type: "err", value: 1 },
    true,
  ]) {
    assert.throws(() => uintValue(v));
  }
});

test("uses gross reserve TVL matching UI and reports trailing on-chain APY", () => {
  const row = buildMetrics(snapshot);
  assert.ok(row.metadata);
  assert.equal(row.symbol, "stBTC");
  assert.equal(row.tvlBtc, 637.96953488);
  assert.equal(row.metadata.stakedSbtc, 633);
  assert.equal(row.metadata.idleSbtc, 4.96953488);
  assert.equal(row.metadata.activeBackingSbtc, 634.87986293);
  assert.equal(row.metadata.activeStbtcSupply, 633.31413466);
  assert.equal(row.metadata.sbtcPerStbtc, 1.00247227);
  assert.equal(row.metadata.rateWindow, "trailing-30d");
  assert.equal(row.rateType, "apy");
  assert.equal(
    row.metadata.apyEvidenceStatus,
    "independently-derived-on-chain",
  );
  assert.ok(Math.abs(row.rate - 1.5898093752) < 1e-9);
});

test("preserves verified flat and negative APY windows through normalization", () => {
  const flat = buildMetrics({ ...snapshot, historicalRatio: snapshot.ratio });
  const negative = buildMetrics({
    ...snapshot,
    historicalRatio: snapshot.ratio + 100000n,
  });
  assert.equal(flat.rate, 0);
  assert.equal(flat.metadata!.allowZeroRate, true);
  assert.ok(negative.rate < 0);
  const normalized = normalize([flat, negative], adapter, 80000, new Date());
  assert.equal(normalized[0]!.rate, 0);
  assert.equal(normalized[1]!.rate, negative.rate);
  assert.ok(normalized.every((row) => row.rateType === "apy"));
});

test("rejects bad balances and unsupported ratios instead of silent zeros", () => {
  assert.throws(() => buildMetrics({ ...snapshot, total: 0n }));
  assert.throws(() =>
    buildMetrics({ ...snapshot, reserved: snapshot.total + 1n }),
  );
  assert.throws(() => buildMetrics({ ...snapshot, pending: snapshot.supply }));
  assert.throws(() => buildMetrics({ ...snapshot, ratio: 100000000n }));
  assert.throws(() => buildMetrics({ ...snapshot, historicalRatio: 0n }));
});

test("reconstructs post-cutoff share and reserve deltas from contract print events", () => {
  assert.deepEqual(
    stateDeltasAfterCutoff(
      [
        { blockHeight: 11, action: "deposit", data: { "stbtc-amount": 100n } },
        {
          blockHeight: 12,
          action: "withdraw-idle",
          data: { "stbtc-amount": 5n },
        },
        {
          blockHeight: 13,
          action: "init-withdraw",
          data: { "stbtc-amount": 20n },
        },
        {
          blockHeight: 14,
          action: "request-sbtc-to-stack",
          data: { "requested-sbtc": 30n },
        },
        {
          blockHeight: 15,
          action: "lock-sbtc-for-withdrawal",
          data: { "sbtc-amount": 7n },
        },
        {
          blockHeight: 16,
          action: "return-sbtc-from-stacking",
          data: { "sbtc-amount": 4n },
        },
        {
          blockHeight: 17,
          action: "request-sbtc-for-withdrawal",
          data: { "requested-sbtc": 2n },
        },
        {
          blockHeight: 18,
          action: "unlock-sbtc-from-withdrawal",
          data: { "sbtc-amount": 1n },
        },
        {
          blockHeight: 19,
          action: "withdraw",
          data: { "stbtc-amount": 5n },
        },
        { blockHeight: 9, action: "deposit", data: { "stbtc-amount": 1000n } },
      ],
      10,
    ),
    {
      supply: 90n,
      pending: 15n,
      staked: 26n,
      reserved: 4n,
    },
  );
});

const deployer = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG";
const asset = {
  asset_event_type: "transfer",
  asset_id: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
  sender: `${deployer}.rewards-pox5-v1`,
  recipient: `${deployer}.stbtc-reserve`,
  amount: "123",
};
test("counts actual positive sBTC credits, including nested calls, without double counting", () => {
  const credit = { tx_id: "a", event_type: "fungible_token_asset", asset };
  assert.deepEqual(
    rewardCreditIds([
      credit,
      credit,
      { ...credit, tx_id: "b" },
      { ...credit, tx_id: "c", asset: { ...asset, sender: deployer } },
      { ...credit, tx_id: "d", asset: { ...asset, amount: "0" } },
      { ...credit, tx_id: "e", asset: { ...asset, asset_id: "wrong" } },
    ]),
    ["a", "b"],
  );
});

test("reports bounded observed cadence; excludes unsuccessful and noncanonical transactions", () => {
  const tx = (id: string, time: number, extra = {}) => ({
    tx_id: id,
    block_time: time,
    tx_status: "success",
    canonical: true,
    ...extra,
  });
  const stats = summarizeCredits([
    tx("a", 10000),
    tx("a", 10000),
    tx("b", 6400),
    tx("c", 2800),
    tx("d", 2000, { canonical: false }),
    tx("e", 1000, { tx_status: "abort_by_response" }),
  ]);
  assert.equal(stats.creditCount, 3);
  assert.equal(stats.medianIntervalSeconds, 3600);
  assert.equal(stats.sampleSpanSeconds, 7200);
  assert.equal(stats.lastCreditAt, new Date(10000 * 1000).toISOString());
  assert.equal(summarizeCredits([]).medianIntervalSeconds, null);
  assert.equal(summarizeCredits([tx("a", 10000)]).medianIntervalSeconds, null);
});

test("bulk lookup requires all sampled transactions instead of undercounting missing data", () => {
  const tx = {
    tx_id: "a",
    block_time: 10000,
    tx_status: "success",
    canonical: true,
  };
  assert.deepEqual(
    bulkCreditTransactions(["a"], { a: { found: true, result: tx } }),
    [tx],
  );
  assert.deepEqual(bulkCreditTransactions([], {}), []);
  for (const response of [
    null,
    {},
    { a: { found: false } },
    { a: { found: true } },
  ]) {
    assert.throws(() => bulkCreditTransactions(["a"], response));
  }
});
