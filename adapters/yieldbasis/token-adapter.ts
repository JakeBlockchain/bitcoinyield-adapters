/**
 * Shared Yield Basis staked Token Yield adapter.
 *
 * Staked LT shares earn YB emissions only. The paired yield-bearing adapters
 * own the unstaked LT trading-fee yield measured through share-price growth.
 *
 * The emissions denominator is LT.updated_balances().staked rather than the
 * gauge's totalSupply. The gauge wraps LT shares, and its boost/share math can
 * make gauge supply diverge from the LT's authoritative staked-share count.
 */

import type { Address } from "viem";

// Deep imports on purpose: "@bitcoinyield/adapters" re-exports the adapter
// registry, and the registry imports the yb-*-token adapters that import
// this helper. Going through the entrypoint here closes that cycle and
// crashes module init (TDZ on productionYieldBasisTokenDependencies).
import { defineAdapter } from "../../src/core/defineAdapter.js";
import type { Adapter } from "../../src/core/types.js";
import * as ethereum from "../../src/core/utils/chains/ethereum.js";
import * as http from "../../src/core/utils/http.js";
import * as math from "../../src/core/utils/math.js";
import * as prices from "../../src/core/utils/prices.js";
import { requirePositive } from "../../src/core/utils/validators.js";

export const EMISSIONS_WINDOW_SECONDS = 86_400;
export const SECONDS_PER_YEAR = 31_536_000;
export const FORMULA_VERSION = "yieldbasis-token-emissions-v1";

const LT_VALUE_DECIMALS = 18;
const YB_DECIMALS = 18;

const yieldBasisLtAbi = [
  {
    inputs: [],
    name: "pricePerShare",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "updated_balances",
    outputs: [
      { name: "supply", type: "uint256" },
      { name: "staked", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const gaugeControllerAbi = [
  {
    inputs: [
      { name: "gauge", type: "address" },
      { name: "at_time", type: "uint256" },
    ],
    name: "preview_emissions",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface YieldBasisTokenConfig {
  slug: string;
  name: string;
  symbol: string;
  ltAddress: Address;
  gaugeAddress: Address;
  gaugeController: Address;
  assetAddress: Address;
  assetDecimals: number;
}

export interface YieldBasisTokenSourceBlock {
  number: bigint;
  timestamp: bigint;
}

export interface YieldBasisTokenDependencies {
  getLatestBlock(): Promise<YieldBasisTokenSourceBlock>;
  readBalances(
    ltAddress: Address,
    blockNumber: bigint,
  ): Promise<readonly [bigint, bigint]>;
  readSharePrice(ltAddress: Address, blockNumber: bigint): Promise<bigint>;
  previewEmissions(
    controller: Address,
    gauge: Address,
    atTime: bigint,
    blockNumber: bigint,
  ): Promise<bigint>;
  getYbPriceUsd(): Promise<number>;
  getBtcPriceUsd(): Promise<number>;
}

export interface YieldBasisTokenMetricInputs {
  stakedSharesRaw: bigint;
  pricePerShareRaw: bigint;
  emissionsNowRaw: bigint;
  emissionsFutureRaw: bigint;
  ybPriceUsd: number;
  btcPriceUsd: number;
}

export interface YieldBasisTokenMetrics {
  stakedShares: number;
  sharePrice: number;
  tvlBtc: number;
  ybPerYear: number;
  emissionsApr: number;
}

export function calculateYieldBasisTokenMetrics({
  stakedSharesRaw,
  pricePerShareRaw,
  emissionsNowRaw,
  emissionsFutureRaw,
  ybPriceUsd,
  btcPriceUsd,
}: YieldBasisTokenMetricInputs): YieldBasisTokenMetrics {
  if (emissionsFutureRaw <= emissionsNowRaw) {
    throw new Error(
      "emissionsFuture must be greater than emissionsNow for a positive YB emissions window",
    );
  }

  // LT shares and pricePerShare are always 18-decimal values, regardless of
  // the underlying BTC asset's decimals. YB emissions are also 18 decimals.
  const stakedShares = math.fromUnits(stakedSharesRaw, LT_VALUE_DECIMALS);
  const sharePrice = math.fromUnits(pricePerShareRaw, LT_VALUE_DECIMALS);
  const ybEmitted = math.fromUnits(
    emissionsFutureRaw - emissionsNowRaw,
    YB_DECIMALS,
  );

  requirePositive(stakedShares, "stakedShares");
  requirePositive(sharePrice, "sharePrice");
  requirePositive(ybPriceUsd, "ybPriceUsd");
  requirePositive(btcPriceUsd, "btcPriceUsd");

  const tvlBtc = math.mul(stakedShares, sharePrice);
  requirePositive(tvlBtc, "tvlBtc");

  const stakedTvlUsd = math.mul(tvlBtc, btcPriceUsd);
  const ybPerYear = math.div(
    math.mul(ybEmitted, SECONDS_PER_YEAR),
    EMISSIONS_WINDOW_SECONDS,
  );
  const emissionsApr = math.mul(
    math.div(math.mul(ybPerYear, ybPriceUsd), stakedTvlUsd),
    100,
  );

  return {
    stakedShares,
    sharePrice,
    tvlBtc,
    ybPerYear,
    emissionsApr,
  };
}

interface YieldBasisProtocolMetricsResponse {
  success: boolean;
  data?: { bucketStart?: number; ybPriceRaw?: string };
}

// Protocol metrics are bucketed hourly; a few missed buckets is tolerable,
// older than this means their indexer stalled and the price is frozen.
const MAX_YB_PRICE_AGE_SECONDS = 6 * 60 * 60;

export function parseYbPriceFromProtocolMetrics(
  response: YieldBasisProtocolMetricsResponse,
  nowMs: number = Date.now(),
): number {
  const { bucketStart, ybPriceRaw } = response.data ?? {};
  if (!response.success || typeof bucketStart !== "number") {
    throw new Error("YieldBasis protocol metrics: malformed response");
  }
  const ageSeconds = Math.floor(nowMs / 1000) - bucketStart;
  if (ageSeconds > MAX_YB_PRICE_AGE_SECONDS) {
    throw new Error(
      `YieldBasis protocol metrics: ybPriceRaw is stale ` +
        `(bucketStart ${bucketStart}, ${Math.floor(ageSeconds / 3600)}h old)`,
    );
  }
  // 1e18-scaled integer string, like every other *Raw field on this API.
  if (typeof ybPriceRaw !== "string" || !/^\d+$/.test(ybPriceRaw)) {
    throw new Error(
      `YieldBasis protocol metrics: ybPriceRaw is not a 1e18-scaled integer: "${ybPriceRaw}"`,
    );
  }
  return requirePositive(math.fromUnits(ybPriceRaw, 18), "ybPriceRaw");
}

// CoinGecko 403s requests from Vercel, so it goes last. Yield Basis's own
// API leads; Coinbase covers it being down.
const YB_PRICE_SOURCES: Array<{ label: string; load: () => Promise<number> }> =
  [
    {
      label: "yieldbasis",
      load: async () =>
        parseYbPriceFromProtocolMetrics(
          await http.get<YieldBasisProtocolMetricsResponse>(
            "https://api.yieldbasis.com/v1/analytics/protocol/metrics",
            { retries: 1 },
          ),
        ),
    },
    {
      label: "coinbase",
      load: async () => {
        const res = await http.get<{ data?: { amount?: string } }>(
          "https://api.coinbase.com/v2/prices/YB-USD/spot",
          { retries: 1 },
        );
        return requirePositive(res.data?.amount, "coinbase YB-USD");
      },
    },
    { label: "coingecko", load: () => prices.getToken("yield-basis") },
  ];

export async function fetchYbPriceUsd(): Promise<number> {
  const failures: string[] = [];
  for (const source of YB_PRICE_SOURCES) {
    try {
      return await source.load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${source.label}: ${message.slice(0, 200)}`);
      // eslint-disable-next-line no-console
      console.warn(
        `[yieldbasis] YB price from ${source.label} failed: ${message}`,
      );
    }
  }
  throw new Error(`All YB price sources failed — ${failures.join("; ")}`);
}

export const productionYieldBasisTokenDependencies: YieldBasisTokenDependencies =
  {
    async getLatestBlock() {
      const block = await ethereum.getClient().getBlock({ blockTag: "latest" });
      return { number: block.number, timestamp: block.timestamp };
    },
    async readBalances(ltAddress, blockNumber) {
      return await ethereum.getClient().readContract({
        address: ltAddress,
        abi: yieldBasisLtAbi,
        functionName: "updated_balances",
        blockNumber,
      });
    },
    async readSharePrice(ltAddress, blockNumber) {
      return await ethereum.getClient().readContract({
        address: ltAddress,
        abi: yieldBasisLtAbi,
        functionName: "pricePerShare",
        blockNumber,
      });
    },
    async previewEmissions(controller, gauge, atTime, blockNumber) {
      return await ethereum.getClient().readContract({
        address: controller,
        abi: gaugeControllerAbi,
        functionName: "preview_emissions",
        args: [gauge, atTime],
        blockNumber,
      });
    },
    async getYbPriceUsd() {
      return await fetchYbPriceUsd();
    },
    async getBtcPriceUsd() {
      return await prices.getBtc();
    },
  };

export function createYieldBasisTokenAdapter(
  config: YieldBasisTokenConfig,
  dependencies: YieldBasisTokenDependencies = productionYieldBasisTokenDependencies,
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
      const emissionsFutureTimestamp =
        sourceBlock.timestamp + BigInt(EMISSIONS_WINDOW_SECONDS);

      const [
        balances,
        pricePerShareRaw,
        emissionsNowRaw,
        emissionsFutureRaw,
        ybPriceUsd,
        btcPriceUsd,
      ] = await Promise.all([
        dependencies.readBalances(config.ltAddress, sourceBlock.number),
        dependencies.readSharePrice(config.ltAddress, sourceBlock.number),
        dependencies.previewEmissions(
          config.gaugeController,
          config.gaugeAddress,
          sourceBlock.timestamp,
          sourceBlock.number,
        ),
        dependencies.previewEmissions(
          config.gaugeController,
          config.gaugeAddress,
          emissionsFutureTimestamp,
          sourceBlock.number,
        ),
        dependencies.getYbPriceUsd(),
        dependencies.getBtcPriceUsd(),
      ]);

      const [, stakedSharesRaw] = balances;
      const metrics = calculateYieldBasisTokenMetrics({
        stakedSharesRaw,
        pricePerShareRaw,
        emissionsNowRaw,
        emissionsFutureRaw,
        ybPriceUsd,
        btcPriceUsd,
      });

      return [
        {
          symbol: config.symbol,
          tvlBtc: metrics.tvlBtc,
          rate: metrics.emissionsApr,
          rateType: "apr",
          metadata: {
            ltAddress: config.ltAddress,
            gaugeAddress: config.gaugeAddress,
            gaugeController: config.gaugeController,
            assetAddress: config.assetAddress,
            assetDecimals: config.assetDecimals,
            sharePrice: metrics.sharePrice,
            stakedShares: metrics.stakedShares,
            emissionsApr: metrics.emissionsApr,
            ybPerYear: metrics.ybPerYear,
            ybPriceUsd,
            btcPriceUsd,
            emissionsWindowSeconds: EMISSIONS_WINDOW_SECONDS,
            sourceBlockNumber: sourceBlock.number.toString(),
            sourceBlockTimestamp: sourceBlock.timestamp.toString(),
            formulaVersion: FORMULA_VERSION,
          },
        },
      ];
    },
  });
}
