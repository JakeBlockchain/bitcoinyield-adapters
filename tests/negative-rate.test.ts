import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBoundaries,
  BOUNDARIES,
} from "../src/core/pipeline/boundaries.js";
import { normalize } from "../src/core/pipeline/normalize.js";
import type {
  Adapter,
  AdapterResult,
  BoundaryAlert,
  MetricRow,
  Notifier,
} from "../src/core/types.js";

function row(overrides: Partial<MetricRow> = {}): MetricRow {
  return {
    symbol: "yb-WBTC",
    tvlBtc: 129.8,
    tvlUsd: 12_980_000,
    btcPrice: 100_000,
    rate: 1.5,
    rateType: "apy",
    timestamp: new Date("2026-08-07T00:00:00.000Z"),
    ...overrides,
  };
}

function capturingNotifier() {
  const alerts: BoundaryAlert[] = [];
  const notifier: Notifier = {
    async boundary(alert) {
      alerts.push(alert);
    },
    async spike() {},
    async staleness() {},
    async regression() {},
  };
  return { notifier, alerts };
}

test("a negative apy is kept", async () => {
  const { notifier, alerts } = capturingNotifier();
  const result = await applyBoundaries(
    [row({ rate: -0.37, rateType: "apy" })],
    "yb-wbtc-yieldbearing",
    notifier,
  );

  assert.equal(result.kept.length, 1);
  assert.equal(alerts.length, 0);
});

test("a negative apr is dropped", async () => {
  const { notifier, alerts } = capturingNotifier();
  const result = await applyBoundaries(
    [row({ rate: -0.37, rateType: "apr" })],
    "some-apr-adapter",
    notifier,
  );

  assert.equal(result.kept.length, 0);
  assert.equal(alerts[0]?.threshold, BOUNDARIES.rate.apr.lb);
});

test("an apy below -100% is dropped", async () => {
  const { notifier, alerts } = capturingNotifier();
  const result = await applyBoundaries(
    [row({ rate: -150, rateType: "apy" })],
    "yb-wbtc-yieldbearing",
    notifier,
  );

  assert.equal(result.kept.length, 0);
  assert.equal(alerts[0]?.threshold, BOUNDARIES.rate.apy.lb);
});

test("a negative apy passes normalize untouched", () => {
  const adapter = { slug: "yb-wbtc-yieldbearing" } as Adapter;
  const rows = normalize(
    [{ symbol: "yb-WBTC", tvlBtc: 129.8, rate: -0.37, rateType: "apy" }],
    adapter,
    100_000,
    new Date(),
  );
  assert.equal(rows[0]?.rate, -0.37);
});

test("a zero rate without allowZeroRate still fails loudly", () => {
  const adapter = { slug: "yb-wbtc-yieldbearing" } as Adapter;
  assert.throws(
    () =>
      normalize(
        [
          {
            symbol: "yb-WBTC",
            tvlBtc: 129.8,
            rate: 0,
            rateType: "apy",
          },
        ],
        adapter,
        100_000,
        new Date(),
      ),
    /rate=0/,
    "a frozen share price must not store as 0%",
  );
});

test("a row without a valid rateType fails loudly", () => {
  const adapter = { slug: "some-adapter" } as Adapter;
  for (const rateType of [undefined, "APY", "yield"]) {
    assert.throws(
      () =>
        normalize(
          [
            {
              symbol: "BTC",
              tvlBtc: 1,
              rate: 2,
              rateType,
            } as unknown as AdapterResult,
          ],
          adapter,
          100_000,
          new Date(),
        ),
      /invalid rateType/,
    );
  }
});

test("normalize carries rateType through to the row", () => {
  const adapter = { slug: "some-adapter" } as Adapter;
  const [out] = normalize(
    [{ symbol: "BTC", tvlBtc: 1, rate: 2, rateType: "apr" }],
    adapter,
    100_000,
    new Date(),
  );
  assert.equal(out?.rateType, "apr");
});
