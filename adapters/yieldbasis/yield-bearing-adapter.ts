/**
 * Shared Yield Basis Real Yield adapter.
 *
 * Rate is Yield Basis's official 30-day fundamental trading APY
 * (`tradingApy`). That is the unlabeled field on
 * `/v1/analytics/markets/trading-apy` and matches the dashboard's
 * FT APY (30D) column. TVL stays on-chain, with both LT reads pinned to
 * one block (and that block recorded in metadata) so supply and share
 * price cannot mix chain states.
 *
 * The APY is published as-is, negative included: a losing 30d window means
 * a depositor exiting now gets back less than they put in.
 *
 * An analytics API failure fails the whole run, TVL included — normalize
 * requires a rate on every row, so a TVL-only row is not an option.
 */

import type { Address } from "viem";

// Deep imports on purpose: "@bitcoinyield/adapters" re-exports the adapter
// registry, and the registry imports the yb-* adapters that import this
// helper. Going through the entrypoint here closes that cycle and crashes
// module init.
import { defineAdapter } from "../../src/core/defineAdapter.js";
import type { Adapter } from "../../src/core/types.js";
import * as http from "../../src/core/utils/http.js";
import * as math from "../../src/core/utils/math.js";
import { requirePositive } from "../../src/core/utils/validators.js";
import {
  productionYieldBasisTokenDependencies,
  type YieldBasisTokenSourceBlock,
} from "./token-adapter.js";

const RATE_DECIMALS = 18;
const FORMULA_VERSION = "yieldbasis-trading-apy-30d-v1";
// Buckets are daily; a latest bucket older than this means the indexer
// stalled, and publishing its APY would silently freeze our figure (the
// zenrock failure mode). Fail loudly instead.
const MAX_BUCKET_AGE_SECONDS = 72 * 60 * 60;

export interface YieldBasisYieldBearingConfig {
  slug: string;
  name: string;
  symbol: string;
  marketId: string;
  ltAddress: Address;
  assetAddress: Address;
  assetDecimals: number;
}

export interface YieldBasisThirtyDayApy {
  bucketStart: number;
  apyRaw: string;
  sourceTimestamp: string;
}

export interface YieldBasisYieldBearingDependencies {
  getLatestBlock(): Promise<YieldBasisTokenSourceBlock>;
  readBalances(
    ltAddress: Address,
    blockNumber: bigint,
  ): Promise<readonly [bigint, bigint]>;
  readSharePrice(ltAddress: Address, blockNumber: bigint): Promise<bigint>;
  getThirtyDayApy(marketId: string): Promise<YieldBasisThirtyDayApy>;
}

interface YieldBasisTradingApyResponse {
  success: boolean;
  data: Array<{
    bucketStart: number;
    marketId: string | number;
    tradingApy?: string | null;
  }>;
  timestamp: string;
}

export function selectLatestThirtyDayApy(
  response: YieldBasisTradingApyResponse,
  marketId: string,
  nowMs: number = Date.now(),
): YieldBasisThirtyDayApy {
  if (!response.success || !Array.isArray(response.data)) {
    throw new Error(
      `YieldBasis market ${marketId}: malformed trading APY response`,
    );
  }

  // String() both sides so an upstream switch to numeric ids keeps matching.
  // A just-opened bucket can be published before its APY is computed, so
  // skip valueless rows rather than failing on them.
  const usable = response.data.filter(
    (row) =>
      String(row.marketId) === marketId &&
      typeof row.tradingApy === "string" &&
      row.tradingApy !== "",
  );
  if (usable.length === 0) {
    throw new Error(`YieldBasis market ${marketId}: no trading APY data`);
  }

  // ">=" so a corrected row appended later for the same bucket wins.
  const latest = usable.reduce((current, row) =>
    row.bucketStart >= current.bucketStart ? row : current,
  );

  const bucketAgeSeconds = Math.floor(nowMs / 1000) - latest.bucketStart;
  if (bucketAgeSeconds > MAX_BUCKET_AGE_SECONDS) {
    throw new Error(
      `YieldBasis market ${marketId}: latest trading APY bucket is stale ` +
        `(bucketStart ${latest.bucketStart}, ${Math.floor(bucketAgeSeconds / 3600)}h old)`,
    );
  }

  // tradingApy must be a 1e18-scaled integer string. If the API ever
  // switches to a plain decimal ("0.0091"), fromUnits would produce a
  // near-zero apr that passes every downstream guard silently.
  const apyRaw = latest.tradingApy as string;
  if (!/^-?\d+$/.test(apyRaw)) {
    throw new Error(
      `YieldBasis market ${marketId}: tradingApy is not a 1e18-scaled integer: "${apyRaw}"`,
    );
  }

  return {
    bucketStart: latest.bucketStart,
    apyRaw,
    sourceTimestamp: response.timestamp,
  };
}

// One feed fetch serves all three yb-* yield-bearing adapters in the same
// process/cycle (mirrors the prices.getBtc cache; mostly a no-op on cold
// lambdas, collapses 3 fetches to 1 on the Node server and CLI).
const TRADING_APY_URL = "https://api.yieldbasis.com/v1/analytics/markets/trading-apy";
const FEED_CACHE_TTL_MS = 5 * 60 * 1000;
let feedCache: {
  at: number;
  promise: Promise<YieldBasisTradingApyResponse>;
} | null = null;

function fetchTradingApyFeed(): Promise<YieldBasisTradingApyResponse> {
  const now = Date.now();
  if (feedCache && now - feedCache.at < FEED_CACHE_TTL_MS) {
    return feedCache.promise;
  }
  const promise = http
    .get<YieldBasisTradingApyResponse>(TRADING_APY_URL)
    .catch((err) => {
      feedCache = null;
      throw err;
    });
  feedCache = { at: now, promise };
  return promise;
}

export const productionYieldBasisYieldBearingDependencies: YieldBasisYieldBearingDependencies =
  {
    // The LT reads are shared with the token adapter family so both
    // families read the same ABI through the same pinned-block contract.
    getLatestBlock: productionYieldBasisTokenDependencies.getLatestBlock,
    readBalances: productionYieldBasisTokenDependencies.readBalances,
    readSharePrice: productionYieldBasisTokenDependencies.readSharePrice,
    async getThirtyDayApy(marketId) {
      const response = await fetchTradingApyFeed();
      return selectLatestThirtyDayApy(response, marketId);
    },
  };

export function createYieldBasisYieldBearingAdapter(
  config: YieldBasisYieldBearingConfig,
  dependencies: YieldBasisYieldBearingDependencies = productionYieldBasisYieldBearingDependencies,
): Adapter {
  return defineAdapter({
    slug: config.slug,
    name: config.name,
    url: "https://yieldbasis.com",
    category: "lp",
    custody: "multisig",
    requires: { rpc: ["ethereum"] },

    async fetch() {
      const sourceBlock = await dependencies.getLatestBlock();
      const [balances, pricePerShareRaw, thirtyDayApy] = await Promise.all([
        dependencies.readBalances(config.ltAddress, sourceBlock.number),
        dependencies.readSharePrice(config.ltAddress, sourceBlock.number),
        dependencies.getThirtyDayApy(config.marketId),
      ]);

      const [supplyRaw, stakedRaw] = balances;
      const totalSupply = math.fromUnits(supplyRaw, 18);
      const stakedSupply = math.fromUnits(stakedRaw, 18);
      const yieldBearingShares = math.fromUnits(supplyRaw - stakedRaw, 18);
      const sharePrice = math.fromUnits(pricePerShareRaw, 18);
      requirePositive(yieldBearingShares, "yieldBearingShares");
      requirePositive(sharePrice, "sharePrice");

      const tvlBtc = math.mul(yieldBearingShares, sharePrice);
      requirePositive(tvlBtc, "tvlBtc");

      const apy = math.toPercent(
        math.fromUnits(thirtyDayApy.apyRaw, RATE_DECIMALS),
      );

      return [
        {
          symbol: config.symbol,
          tvlBtc,
          rate: apy,
          rateType: "apy",
          metadata: {
            rateSource: "yieldbasis-api-trading-apy-30d",
            rateWindow: "30d",
            marketId: config.marketId,
            bucketStart: thirtyDayApy.bucketStart,
            sourceTimestamp: thirtyDayApy.sourceTimestamp,
            rawApy: thirtyDayApy.apyRaw,
            ltAddress: config.ltAddress,
            assetAddress: config.assetAddress,
            assetDecimals: config.assetDecimals,
            sharePrice,
            totalSupply,
            stakedSupply,
            yieldBearingShares,
            sourceBlockNumber: sourceBlock.number.toString(),
            sourceBlockTimestamp: sourceBlock.timestamp.toString(),
            formulaVersion: FORMULA_VERSION,
          },
        },
      ];
    },
  });
}
