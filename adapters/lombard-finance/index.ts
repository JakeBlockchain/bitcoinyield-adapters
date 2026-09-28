/**
 * Lombard Finance: provider-reported 30-day net APY from the transparency
 * dashboard. Ethereum-only TVL remains totalSupply() * getRate().
 * Archive exchange-rate growth is retained separately for comparison;
 * it is not equivalent to the provider's published APY.
 */

import {
  defineAdapter,
  ethereum,
  http,
  math,
  readShareGrowth,
  requirePositive,
  BLOCKS_PER_30D,
} from "@bitcoinyield/adapters";

import { parseTransparencyReport, TRANSPARENCY_REPORT_URL } from "./report.js";

const LBTC_ADDRESS = "0x8236a87084f8B84306f72007F36F2618A5634494" as const;
const RATE_DECIMALS = 18;
const BLOCKS_PER_7D_ETHEREUM = 50_400n;
// Lombard's published target at full strategy deployment. Informational
// metadata only — never the headline apr.
const TARGET_APY_PCT = 2.5;

const rateAbi = [
  {
    inputs: [],
    name: "getRate",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default defineAdapter({
  slug: "lombard-finance",
  name: "Lombard",
  url: "https://www.lombard.finance/app/stake/",
  category: "yield-bearing",
  custody: "multisig",
  requires: { rpc: ["ethereum"] },

  async fetch() {
    const client = ethereum.getClient();

    const [calls, growth7d, growth30d, reportData] = await Promise.all([
      ethereum.multicall([
        {
          address: LBTC_ADDRESS,
          abi: ethereum.erc20Abi,
          functionName: "totalSupply",
        },
        {
          address: LBTC_ADDRESS,
          abi: ethereum.erc20Abi,
          functionName: "decimals",
        },
        {
          address: LBTC_ADDRESS,
          abi: rateAbi,
          functionName: "getRate",
        },
      ]),
      readShareGrowth({
        client,
        address: LBTC_ADDRESS,
        abi: rateAbi,
        functionName: "getRate",
        blocksBack: BLOCKS_PER_7D_ETHEREUM,
        decimals: RATE_DECIMALS,
      }),
      readShareGrowth({
        client,
        address: LBTC_ADDRESS,
        abi: rateAbi,
        functionName: "getRate",
        blocksBack: BLOCKS_PER_30D.ethereum,
        decimals: RATE_DECIMALS,
      }),
      http.get<unknown>(TRANSPARENCY_REPORT_URL),
    ]);

    const [supplyCall, decimalsCall, rateCall] = calls;
    if (
      supplyCall?.status !== "success" ||
      decimalsCall?.status !== "success" ||
      rateCall?.status !== "success"
    ) {
      throw new Error(
        `LBTC multicall failed: supply=${supplyCall?.status} decimals=${decimalsCall?.status} rate=${rateCall?.status}`,
      );
    }

    const ethereumSupply = requirePositive(
      math.fromUnits(
        supplyCall.result as bigint,
        decimalsCall.result as number,
      ),
      "lbtc.totalSupply",
    );
    const btcPerLbtc = requirePositive(
      math.fromUnits(rateCall.result as bigint, RATE_DECIMALS),
      "lbtc.getRate",
    );
    const tvlBtc = requirePositive(
      math.mul(ethereumSupply, btcPerLbtc),
      "tvlBtc",
    );

    const report = parseTransparencyReport(reportData);

    return [
      {
        symbol: "LBTC",
        tvlBtc,
        rate: report.apyPct,
        rateType: "apy",
        metadata: {
          ...(report.apyPct === 0 && { allowZeroRate: true }),
          rateWindow: "30d",
          rateBasis: "provider-reported-net",
          rateSource: TRANSPARENCY_REPORT_URL,
          sourceAsOf: report.asOf,
          sourceCreatedAt: report.createdAt,
          sourceReportId: report.id,
          sourceApyDecimal: report.apyDecimal,
          sourceFetchedAt: new Date().toISOString(),
          onchainWindowDays7d: growth7d.hasBaseline
            ? growth7d.elapsedDays
            : null,
          onchainWindowDays30d: growth30d.hasBaseline
            ? growth30d.elapsedDays
            : null,
          onchainRateThen30d: growth30d.hasBaseline
            ? growth30d.sharePriceThen
            : null,
          apy7d: growth7d.hasBaseline ? growth7d.apy : null,
          apy30d: growth30d.hasBaseline ? growth30d.apy : null,
          linearApr7d: growth7d.hasBaseline ? growth7d.apr : null,
          linearApr30d: growth30d.hasBaseline ? growth30d.apr : null,
          targetApyPct: TARGET_APY_PCT,
          contractAddress: LBTC_ADDRESS,
          decimals: decimalsCall.result,
          ethereumSupply,
          exchangeRateBtcPerLbtc: btcPerLbtc,
          transparencyUrl: "https://www.lombard.finance/transparency/lbtc",
        },
      },
    ];
  },
});
