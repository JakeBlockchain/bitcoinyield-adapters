/**
 * Solv BTC+ adapter — Solv's central API.
 *
 * TVL: /btcplus/stats.
 * APY: 30-day compounded growth of Solv's daily NAV series (/btcplus/navs),
 *      plus the stats endpoint's rewardApy. The NAV accrues at the rate
 *      Solv's headline `baseApy` quotes (3.000% on 2026-09-30 over 7, 30 and
 *      90 days alike); reading the series instead of the headline means a
 *      NAV markdown shows up, negative if the window lost money.
 */

import {
  defineAdapter,
  math,
  http,
  parseNumber,
  requirePositive,
} from "@bitcoinyield/adapters";

const SOLV_STATS = "https://api.solvprotocol.org/btcplus/stats";
const SOLV_NAVS = "https://api.solvprotocol.org/btcplus/navs";
const APY_WINDOW_DAYS = 30;
// Daily series; a much shorter window means missing days, and annualizing
// it would overweight a few of them.
const MIN_WINDOW_DAYS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SolvResponse {
  tvl: string;
  tvlUsd: string;
  baseApy: string;
  rewardApy: string;
}

interface SolvNavs {
  serialData: Array<{ navDate: string; nav: string }>;
}

export default defineAdapter({
  slug: "solv-btc-plus",
  name: "Solv BTC+",
  url: "https://solv.finance",
  category: "yield-bearing",
  custody: "multisig",

  async fetch() {
    const [data, navs] = await Promise.all([
      http.get<SolvResponse>(SOLV_STATS),
      http.get<SolvNavs>(SOLV_NAVS),
    ]);

    // navDate is YYYY-MM-DD, so string order is date order.
    const series = [...(navs.serialData ?? [])].sort((a, b) =>
      a.navDate.localeCompare(b.navDate),
    );
    const latest = series.at(-1);
    if (!latest) throw new Error("Solv navs returned no data");
    const targetMs = Date.parse(latest.navDate) - APY_WINDOW_DAYS * DAY_MS;
    const baseline = [...series]
      .reverse()
      .find((p) => Date.parse(p.navDate) <= targetMs);
    if (!baseline) {
      throw new Error(`Solv navs has no point ${APY_WINDOW_DAYS}d back`);
    }
    const windowDays =
      (Date.parse(latest.navDate) - Date.parse(baseline.navDate)) / DAY_MS;
    if (windowDays < MIN_WINDOW_DAYS) {
      throw new Error(`Solv navs window too short (${windowDays} days)`);
    }

    const navNow = math.fromUnits(requirePositive(latest.nav, "nav"), 18);
    const navThen = math.fromUnits(
      requirePositive(baseline.nav, "baseline nav"),
      18,
    );
    const navApy = math.mul(
      math.sub(Math.pow(math.div(navNow, navThen), 365 / windowDays), 1),
      100,
    );
    const rewardApy = parseNumber(data.rewardApy, 0);

    return [
      {
        symbol: "BTC+",
        tvlBtc: requirePositive(data.tvl, "tvl"),
        tvlUsd: requirePositive(data.tvlUsd, "tvlUsd"),
        rate: math.add(navApy, rewardApy),
        rateType: "apy",
        metadata: {
          navApy,
          rewardApy,
          reportedBaseApy: parseNumber(data.baseApy, 0),
          nav: navNow,
          nav30dAgo: navThen,
          navDate: latest.navDate,
          windowDays,
          rateSource: "solv-nav-series-30d-apy",
        },
      },
    ];
  },
});
