import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LP_TOKEN,
  STRATEGY,
  WBTC,
} from "../adapters/two-prime-axiom/constants.js";
import {
  buildResult,
  type ChainSnapshot,
} from "../adapters/two-prime-axiom/result.js";
import {
  MAX_SNAPSHOT_AGE_MS,
  parseSnapshot,
} from "../adapters/two-prime-axiom/snapshot.js";
import { normalize } from "../src/core/pipeline/normalize.js";
import type { Adapter } from "../src/core/types.js";

const now = Date.parse("2026-10-06T21:10:47Z");
function fixture() {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/two-prime-axiom-snapshot.json", import.meta.url),
      "utf8",
    ),
  );
}
const chain: ChainSnapshot = {
  blockNumber: 26135938n,
  timestamp: 1791321047n,
  contractValue: 15011975626n,
  token: WBTC,
  tranche: LP_TOKEN,
  strategy: STRATEGY,
  managementFee: 250n,
  performanceFee: 0n,
  feeScale: 100000n,
  grossApr: 1850000000000000000n,
  defaulted: false,
  isEpochRunning: true,
  epochEnd: 1793625023n,
};

test("reconciles observed WBTC NAV and net APR without relabeling projected APY", () => {
  const source = parseSnapshot(fixture(), now);
  const row = buildResult(source, chain);
  assert.equal(row.tvlBtc, 150.11975626);
  assert.equal(row.rate, 1.6);
  assert.equal(row.rateType, "apr");
  assert.equal(row.metadata?.projectedNetApy, 1.61168729);
  assert.equal(row.metadata?.grossApr, 1.85);
  assert.equal(row.metadata?.managementFeePct, 0.25);
  assert.equal(row.metadata?.rateWindow, "current-loan-terms");
  assert.equal(row.metadata?.sourceAsOf, "2026-10-06T00:09:47.000Z");
  assert.equal(row.metadata?.tvlBlockNumber, "26135938");
  assert.equal(row.tvlUsd, undefined);
  const [normalized] = normalize(
    [row],
    { slug: "two-prime-axiom" } as Adapter,
    100000,
    new Date(now),
  );
  assert.equal(normalized?.tvlUsd, 15011975.626);
});

test("uses fresh on-chain NAV, not the older provider TVL or queued balances", () => {
  const source = parseSnapshot(fixture(), now);
  const row = buildResult(source, { ...chain, contractValue: 15100000000n });
  assert.equal(row.tvlBtc, 151);
  assert.equal(row.metadata?.providerTvlBtc, 150.11975626);
});

test("rejects missing or wrong-vault API responses", () => {
  for (const value of [null, undefined, {}, { data: [] }, { data: [null] }]) {
    assert.throws(() => parseSnapshot(value, now));
  }
  for (const field of ["vaultAddress", "vaultId"]) {
    const data = fixture();
    data.data[0][field] = "wrong";
    assert.throws(() => parseSnapshot(data, now), /different vault/);
  }
  const data = fixture();
  data.data.push(data.data[0]);
  assert.throws(() => parseSnapshot(data, now), /exactly one/);
});

test("rejects missing, null, string, non-finite and negative rates, not just NaN", () => {
  for (const [section, field] of [
    ["APRs", "NET"],
    ["APRs", "GROSS"],
    ["APYs", "NET"],
    ["feePercentage", "MANAGEMENT"],
    ["feePercentage", "PERFORMANCE"],
  ]) {
    for (const value of [null, undefined, "", "1.6", NaN, Infinity, -1]) {
      const data = fixture();
      data.data[0][section!][field!] = value;
      assert.throws(() => parseSnapshot(data, now));
    }
  }
});

test("uses underlying block time for freshness even if the API was rewritten today", () => {
  const data = fixture();
  data.data[0].block.timestamp = (now - MAX_SNAPSHOT_AGE_MS - 1000) / 1000;
  data.data[0].updatedAt = new Date(now).toISOString();
  assert.throws(() => parseSnapshot(data, now), /stale/);
  data.data[0].block.timestamp = now / 1000 + 601;
  assert.throws(() => parseSnapshot(data, now), /future/);
});

test("rejects malformed dates, block numbers and WBTC base units", () => {
  for (const value of [
    undefined,
    "bad",
    "2026-10-05T00:00:00Z",
    "2026-10-07T00:00:00Z",
  ]) {
    const data = fixture();
    data.data[0].updatedAt = value;
    assert.throws(() => parseSnapshot(data, now));
  }
  for (const value of [0, null, "26129661", 1.5]) {
    const data = fixture();
    data.data[0].block.number = value;
    assert.throws(() => parseSnapshot(data, now));
  }
  for (const value of [null, "", "0", "-1", "1.5", "1e8", 15011975626]) {
    const data = fixture();
    data.data[0].TVL.token = value;
    assert.throws(() => parseSnapshot(data, now));
  }
});

test("fails on contract configuration changes, default, missing NAV or lagging RPC", () => {
  const source = parseSnapshot(fixture(), now);
  for (const patch of [
    { token: LP_TOKEN },
    { tranche: WBTC },
    { strategy: WBTC },
    { defaulted: true },
    { contractValue: 0n },
    { feeScale: 0n },
    { blockNumber: 1n },
  ])
    assert.throws(() => buildResult(source, { ...chain, ...patch }));
});

test("does not carry stale rate terms forward after an on-chain change", () => {
  const source = parseSnapshot(fixture(), now);
  for (const patch of [
    { managementFee: 500n },
    { performanceFee: 1000n },
    { grossApr: 2000000000000000000n },
  ])
    assert.throws(
      () => buildResult(source, { ...chain, ...patch }),
      /disagree/,
    );
  assert.throws(
    () => buildResult({ ...source, netApr: 1.85 }, chain),
    /disagree/,
  );
});

test("compares fees in percentages, applying management before performance fees", () => {
  const source = parseSnapshot(fixture(), now);
  const row = buildResult(
    { ...source, performanceFeePct: 10, netApr: 1.44 },
    { ...chain, performanceFee: 10000n },
  );
  assert.equal(row.rate, 1.44);
});

test("preserves an explicitly published zero APR only when chain terms confirm it", () => {
  const source = parseSnapshot(fixture(), now);
  const row = buildResult(
    { ...source, grossApr: 0.25, netApr: 0, projectedNetApy: 0 },
    { ...chain, grossApr: 250000000000000000n },
  );
  assert.equal(row.rate, 0);
  assert.equal(row.metadata?.allowZeroRate, true);
  assert.equal(
    normalize(
      [row],
      { slug: "two-prime-axiom" } as Adapter,
      100000,
      new Date(now),
    )[0]?.rate,
    0,
  );
});
