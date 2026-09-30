import assert from "node:assert/strict";
import { test } from "node:test";

import { config as cbBtcConfig } from "../adapters/yb-cbbtc-yieldbearing/index.js";
import { config as tBtcConfig } from "../adapters/yb-tbtc-yieldbearing/index.js";
import { config as wBtcConfig } from "../adapters/yb-wbtc-yieldbearing/index.js";
import {
  createYieldBasisYieldBearingAdapter,
  selectLatestThirtyDayApy,
  type YieldBasisYieldBearingDependencies,
} from "../adapters/yieldbasis/yield-bearing-adapter.js";

const ONE_ETHER = 10n ** 18n;
const BUCKET_START = 1_788_220_800; // 2026-08-31T00:00:00Z
// Fixed "now" a few hours after the fixture bucket so staleness checks are
// deterministic regardless of wall clock.
const NOW_MS = (BUCKET_START + 8 * 3600) * 1000;

const EXPECTED_CONFIGS = [
  {
    config: cbBtcConfig,
    expected: {
      slug: "yb-cbbtc-yieldbearing",
      name: "Yield Basis YB-cbBTC (Yield Bearing)",
      symbol: "yb-cbBTC",
      marketId: "8",
      ltAddress: "0x722FC3640BA007C3E9867CCdB0dCa59F2e2F29F9",
      assetAddress: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      assetDecimals: 8,
    },
    officialApyRaw: "-11320570079601498",
    expectedApy: -1.1320570079601498,
  },
  {
    config: tBtcConfig,
    expected: {
      slug: "yb-tbtc-yieldbearing",
      name: "Yield Basis YB-tBTC (Yield Bearing)",
      symbol: "yb-tBTC",
      marketId: "9",
      ltAddress: "0x771F7290428d830ECd41E980745c327e507823Ec",
      assetAddress: "0x18084fbA666a33d37592fA2633fD49a74DD93a88",
      assetDecimals: 18,
    },
    officialApyRaw: "-5327043249151938",
    expectedApy: -0.5327043249151938,
  },
  {
    config: wBtcConfig,
    expected: {
      slug: "yb-wbtc-yieldbearing",
      name: "Yield Basis YB-WBTC (Yield Bearing)",
      symbol: "yb-WBTC",
      marketId: "7",
      ltAddress: "0x651D4b8168488FA163D85304662E8278d4c55BAa",
      assetAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      assetDecimals: 8,
    },
    officialApyRaw: "9126729331648391",
    expectedApy: 0.9126729331648391,
  },
] as const;

for (const {
  config,
  expected,
  officialApyRaw,
  expectedApy,
} of EXPECTED_CONFIGS) {
  test(`${expected.slug} publishes the official 30d trading APY`, async () => {
    assert.deepEqual(config, expected);

    const calls: string[] = [];
    const dependencies: YieldBasisYieldBearingDependencies = {
      async getLatestBlock() {
        calls.push("block");
        return { number: 123n, timestamp: 456n };
      },
      async readBalances(ltAddress, blockNumber) {
        calls.push(`balances:${ltAddress}@${blockNumber}`);
        return [20n * ONE_ETHER, 8n * ONE_ETHER];
      },
      async readSharePrice(ltAddress, blockNumber) {
        calls.push(`share-price:${ltAddress}@${blockNumber}`);
        return 1_050_000_000_000_000_000n;
      },
      async getThirtyDayApy(marketId) {
        calls.push(`apy:${marketId}`);
        return {
          bucketStart: BUCKET_START,
          apyRaw: officialApyRaw,
          sourceTimestamp: "2026-09-01T17:01:46.302Z",
        };
      },
    };

    const adapter = createYieldBasisYieldBearingAdapter(config, dependencies);
    const rows = await adapter.fetch({ env: {} });
    const row = rows[0];
    assert.ok(row);
    assert.ok(Math.abs(row.rate - expectedApy) < 1e-12);
    assert.equal(row.rateType, "apy");
    assert.equal(row.tvlBtc, 12.6);
    assert.deepEqual(calls, [
      "block",
      `balances:${expected.ltAddress}@123`,
      `share-price:${expected.ltAddress}@123`,
      `apy:${expected.marketId}`,
    ]);
    assert.deepEqual(row.metadata, {
      rateSource: "yieldbasis-api-trading-apy-30d",
      rateWindow: "30d",
      marketId: expected.marketId,
      bucketStart: BUCKET_START,
      sourceTimestamp: "2026-09-01T17:01:46.302Z",
      rawApy: officialApyRaw,
      ltAddress: expected.ltAddress,
      assetAddress: expected.assetAddress,
      assetDecimals: expected.assetDecimals,
      sharePrice: 1.05,
      totalSupply: 20,
      stakedSupply: 8,
      yieldBearingShares: 12,
      sourceBlockNumber: "123",
      sourceBlockTimestamp: "456",
      formulaVersion: "yieldbasis-trading-apy-30d-v1",
    });
  });
}

test("selects tradingApy from the latest matching market row", () => {
  const selected = selectLatestThirtyDayApy(
    {
      success: true,
      timestamp: "2026-09-01T17:01:46.302Z",
      data: [
        {
          bucketStart: 1_788_134_400,
          marketId: "7",
          tradingApy: "10000000000000000",
        },
        {
          bucketStart: BUCKET_START,
          marketId: "8",
          tradingApy: "-11320570079601498",
        },
        {
          bucketStart: BUCKET_START,
          marketId: "7",
          tradingApy: "9126729331648391",
        },
      ],
    },
    "7",
    NOW_MS,
  );

  assert.deepEqual(selected, {
    bucketStart: BUCKET_START,
    apyRaw: "9126729331648391",
    sourceTimestamp: "2026-09-01T17:01:46.302Z",
  });
});

test("a corrected row appended for the same bucket wins the tie", () => {
  const selected = selectLatestThirtyDayApy(
    {
      success: true,
      timestamp: "2026-09-01T17:01:46.302Z",
      data: [
        { bucketStart: BUCKET_START, marketId: "7", tradingApy: "1" },
        { bucketStart: BUCKET_START, marketId: "7", tradingApy: "2" },
      ],
    },
    "7",
    NOW_MS,
  );

  assert.equal(selected.apyRaw, "2");
});

test("matches marketId served as a JSON number", () => {
  const selected = selectLatestThirtyDayApy(
    {
      success: true,
      timestamp: "2026-09-01T17:01:46.302Z",
      data: [
        { bucketStart: BUCKET_START, marketId: 7, tradingApy: "9126729331648391" },
      ],
    },
    "7",
    NOW_MS,
  );

  assert.equal(selected.apyRaw, "9126729331648391");
});

test("falls back to the previous bucket when the newest has no APY yet", () => {
  const selected = selectLatestThirtyDayApy(
    {
      success: true,
      timestamp: "2026-09-01T17:01:46.302Z",
      data: [
        {
          bucketStart: 1_788_134_400,
          marketId: "7",
          tradingApy: "10000000000000000",
        },
        { bucketStart: BUCKET_START, marketId: "7", tradingApy: null },
      ],
    },
    "7",
    NOW_MS,
  );

  assert.equal(selected.bucketStart, 1_788_134_400);
  assert.equal(selected.apyRaw, "10000000000000000");
});

test("rejects a stale latest bucket instead of freezing the APR", () => {
  const fourDaysLaterMs = (BUCKET_START + 4 * 86_400) * 1000;
  assert.throws(
    () =>
      selectLatestThirtyDayApy(
        {
          success: true,
          timestamp: "2026-09-01T17:01:46.302Z",
          data: [
            {
              bucketStart: BUCKET_START,
              marketId: "7",
              tradingApy: "9126729331648391",
            },
          ],
        },
        "7",
        fourDaysLaterMs,
      ),
    /stale/,
  );
});

test("rejects a malformed response missing the data array", () => {
  assert.throws(
    () =>
      selectLatestThirtyDayApy(
        {
          success: true,
          timestamp: "2026-09-01T17:01:46.302Z",
        } as never,
        "7",
        NOW_MS,
      ),
    /malformed/,
  );
});

test("rejects a tradingApy that is not a 1e18-scaled integer", () => {
  assert.throws(
    () =>
      selectLatestThirtyDayApy(
        {
          success: true,
          timestamp: "2026-09-01T17:01:46.302Z",
          data: [
            { bucketStart: BUCKET_START, marketId: "7", tradingApy: "0.0091" },
          ],
        },
        "7",
        NOW_MS,
      ),
    /not a 1e18-scaled integer/,
  );
});
