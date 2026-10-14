import assert from "node:assert/strict";
import { test } from "node:test";
import { http, normalize } from "@bitcoinyield/adapters";
import adapter from "./index.js";

test(
  "live mainnet reads reconcile with app TVL/rate while APY is chain-derived",
  { skip: process.env.RUN_LIVE_STBTC !== "1", timeout: 120000 },
  async () => {
    const rows = await adapter.fetch({ env: {} });
    const row = rows[0]!;
    const [stats, ratio] = await Promise.all([
      http.get<{ stBtcReserveSbtc: number }>(
        "https://app.stackingdao.com/api/protocol-stats",
      ),
      http.get<{ stbtcRatio: number }>("https://app.stackingdao.com/api/ratio"),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(row.symbol, "stBTC");
    // App data is cached; deposits/reward releases can happen between observations.
    assert.ok(
      Math.abs(row.tvlBtc - stats.stBtcReserveSbtc) / stats.stBtcReserveSbtc <
        0.0001,
    );
    assert.equal(row.metadata!.rateType, "trailing-apy");
    assert.equal(row.metadata!.rateWindow, "trailing-30d");
    assert.equal(
      row.metadata!.apyEvidenceStatus,
      "independently-derived-on-chain",
    );
    assert.ok(row.apr > 0 && row.apr < 10);
    assert.ok(
      Math.abs((row.metadata!.sbtcPerStbtc as number) - ratio.stbtcRatio) <
        0.0000001,
    );
    assert.ok(
      (row.metadata!.rateWindowDays as number) > 29.9 &&
        (row.metadata!.rateWindowDays as number) < 30.1,
    );
    assert.ok(
      (row.metadata!.historicalBlockHeight as number) <
        (row.metadata!.currentBlockHeight as number),
    );
    assert.ok(
      (row.metadata!.compounding as { creditCount: number }).creditCount >= 2,
    );
    assert.equal(normalize(rows, adapter, 80000, new Date()).length, 1);
  },
);
