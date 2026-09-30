/**
 * Amboss Magma adapter — Lightning Network liquidity rentals.
 *
 * Two GraphQL queries:
 *   1. getAmbossStats → completed_size (sats) for TVL
 *   2. getMarketMetrics.lnr_series → daily lnr_yield for APR
 *
 * APR is the mean of the last 7 finalized daily lnr_yield values (the
 * site-wide 7D APR standard; single days swing 10x+). The current-day entry
 * can be unfinalized (lnr_yield = 0), so zero entries are skipped.
 */

import {
  defineAdapter,
  http,
  math,
  parseNumber,
  requirePositive,
} from "@bitcoinyield/adapters";

const AMBOSS_API = "https://amboss.space/graphql";
const APR_WINDOW_DAYS = 7;
// Tolerate a missed day or two in the series, not a mostly-empty window.
const MIN_WINDOW_ENTRIES = 5;

const HEADERS = {
  "amboss-client": "amboss-space",
  "apollographql-client-name": "space-prod",
  "apollographql-client-version": "1.0.0",
};

const MAGMA_QUERY = `query GetAmbossStats {
  getAmbossStats {
    magma_info {
      stats {
        completed_orders completed_fees completed_size average_apr latest_apr
      }
    }
  }
}`;

const LNR_QUERY = `query GetMarketMetrics($from: String!) {
  getMarketMetrics {
    lnr_series(from: $from, period: DAILY) { date lnr lnr_cost lnr_yield }
  }
}`;

interface MagmaData {
  getAmbossStats?: {
    magma_info?: {
      stats?: {
        completed_orders: number;
        completed_fees: string;
        completed_size: string;
        average_apr: string;
        latest_apr: string;
      };
    };
  };
}

interface LnrData {
  getMarketMetrics?: {
    lnr_series?: Array<{
      date: string;
      lnr: string;
      lnr_cost: string;
      lnr_yield: string;
    }>;
  };
}

export default defineAdapter({
  slug: "amboss-magma",
  name: "Amboss Magma",
  url: "https://amboss.space/magma",
  category: "lp",
  custody: "self",

  async fetch() {
    const fromDate = new Date();
    // One spare day so an unfinalized "today" can't leave the window short.
    fromDate.setDate(fromDate.getDate() - (APR_WINDOW_DAYS + 1));
    const from = fromDate.toISOString().split("T")[0]!;

    const [magmaData, lnrData] = await Promise.all([
      http.graphql<MagmaData>(
        AMBOSS_API,
        MAGMA_QUERY,
        {},
        { headers: HEADERS },
      ),
      http.graphql<LnrData>(
        AMBOSS_API,
        LNR_QUERY,
        { from },
        { headers: HEADERS },
      ),
    ]);

    const stats = magmaData.getAmbossStats?.magma_info?.stats;
    if (!stats) throw new Error("Amboss Magma: no stats");

    const series = lnrData.getMarketMetrics?.lnr_series;
    if (!series || series.length === 0)
      throw new Error("Amboss Magma: no LNR series");

    // Skip unfinalized entries, then pick by date rather than assuming the
    // series' sort order.
    const window = series
      .filter((e) => parseNumber(e.lnr_yield, 0) > 0)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, APR_WINDOW_DAYS);
    if (window.length < MIN_WINDOW_ENTRIES) {
      throw new Error(
        `Amboss Magma: only ${window.length} finalized lnr_yield entries in the ` +
          `last ${APR_WINDOW_DAYS + 1} days (need ${MIN_WINDOW_ENTRIES})`,
      );
    }
    const meanYield = math.div(
      math.add(...window.map((e) => parseNumber(e.lnr_yield, 0))),
      window.length,
    );

    return [
      {
        symbol: "BTC",
        // NOTE: completed_size is Magma's cumulative completed-order volume —
        // the closest thing the API exposes to deployed liquidity, but it
        // never decreases when channels close. No per-moment locked figure
        // exists in this API.
        tvlBtc: math.fromUnits(
          requirePositive(stats.completed_size, "completed_size"),
          8,
        ),
        rate: math.toPercent(meanYield),
        rateType: "apr",
        metadata: {
          completedOrders: stats.completed_orders,
          completedFees: stats.completed_fees,
          averageApr: stats.average_apr,
          magmaLatestApr: stats.latest_apr,
          lnrYield7dMean: meanYield,
          lnrWindowEntries: window.length,
          lnrWindowStart: window.at(-1)?.date,
          lnrWindowEnd: window[0]?.date,
        },
      },
    ];
  },
});
