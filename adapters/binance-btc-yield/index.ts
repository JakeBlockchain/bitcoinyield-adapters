/**
 * Binance BTC Yield (BTCY) — custodial fund-style product on Binance Earn.
 *
 * Reads the public bapi endpoints the product page uses (keyless, not
 * behind the site's WAF).
 *
 * TVL: latest daily statistics row's btcTvl.
 * APY: net 30-day NAV return from the statistics series, compounded. NAV
 *      growth is what a holder actually earns, so this can go negative
 *      (e.g. the July 2026 drawdown) and is published as-is. Binance's own
 *      apr14d headline is gross strategy yield that excludes NAV drawdowns
 *      (and is nulled whenever it would be unflattering); it is kept in
 *      metadata.reportedApr14d for comparison only.
 */

import { defineAdapter, http, math, requirePositive } from "@bitcoinyield/adapters";

interface BtcyEnvelope<T> {
  code: string;
  success: boolean;
  data: T;
}

interface BtcyOverview {
  apr14d: string | null;
  currentNav: string | null;
}

interface BtcyStatRow {
  bizDate: string;
  nav: string;
  btcTvl: string;
}

const BAPI = "https://www.binance.com/bapi/earn/v1/public/earn/btcy/project";

const APY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function unwrap<T>(res: BtcyEnvelope<T>, endpoint: string): T {
  if (!res.success || res.code !== "000000") {
    throw new Error(`binance btcy ${endpoint} returned code ${res.code}`);
  }
  return res.data;
}

export default defineAdapter({
  slug: "binance-btc-yield",
  name: "Binance BTC Yield",
  url: "https://www.binance.com/en/earn/btc-yield",
  category: "yield-bearing",
  custody: "custodial",

  async fetch() {
    // Rows are daily (bizDate = midnight UTC). Ask for a couple of days more
    // than the APY window so a late "today" row can't leave it short.
    const end = Date.now();
    const start = end - (APY_WINDOW_DAYS + 3) * DAY_MS;

    // The overview call only carries the headline; statistics is the source
    // of record. Overview failing must not take TVL reporting down with it.
    const [overviewResult, statsRes] = await Promise.all([
      http
        .get<BtcyEnvelope<BtcyOverview>>(`${BAPI}/overview`)
        .then((res) => unwrap(res, "overview"))
        .catch((err) => {
          console.warn(`[binance-btc-yield] overview unavailable: ${err}`);
          return null;
        }),
      http.get<BtcyEnvelope<BtcyStatRow[]>>(
        `${BAPI}/statistics?startTime=${start}&endTime=${end}`,
      ),
    ]);

    const rows = unwrap(statsRes, "statistics");
    const latest = rows.at(-1);
    if (!latest) throw new Error("binance btcy statistics returned no rows");

    const tvlBtc = requirePositive(latest.btcTvl, "btcTvl");
    const navNow = requirePositive(latest.nav, "nav");

    const targetDate = Number(latest.bizDate) - APY_WINDOW_DAYS * DAY_MS;
    const baseline = rows.reduce((best, row) =>
      Math.abs(Number(row.bizDate) - targetDate) <
      Math.abs(Number(best.bizDate) - targetDate)
        ? row
        : best,
    );
    const windowDays =
      (Number(latest.bizDate) - Number(baseline.bizDate)) / DAY_MS;
    if (windowDays < APY_WINDOW_DAYS / 2) {
      throw new Error(
        `binance btcy statistics window too short (${windowDays} days)`,
      );
    }
    const navThen = requirePositive(baseline.nav, "baseline nav");
    const apy = math.mul(
      math.sub(Math.pow(math.div(navNow, navThen), 365 / windowDays), 1),
      100,
    );

    // apr14d arrives as a fraction string (0.0022 = 0.22%) or null.
    const reportedApr14d = overviewResult?.apr14d
      ? math.mul(parseFloat(overviewResult.apr14d), 100)
      : null;

    return [
      {
        symbol: "BTCY",
        tvlBtc,
        rate: apy,
        rateType: "apy",
        metadata: {
          rateSource: "nav-series-30d-apy",
          reportedApr14d,
          nav: navNow,
          nav30dAgo: navThen,
          windowDays,
          tvlAsOf: Number(latest.bizDate),
        },
      },
    ];
  },
});
