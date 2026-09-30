/**
 * Midas mHyperBTC adapter.
 *
 * TVL is Ethereum circulating supply * current NAV from the official Midas
 * data feed. The token is also deployed natively on Rootstock and as a
 * LayerZero OFT on Monad; those balances are recorded in metadata and are
 * not added into headline TVL in this first version.
 *
 * Headline rate is the 30-day compounded NAV APY (the site-wide APY
 * standard); the 7-day window is recorded in metadata and only headlines
 * when the 30d read is unavailable. The strategy is actively managed, so a
 * trailing window can legitimately go negative and is published as-is.
 */

import {
  defineAdapter,
  ethereum,
  math,
  readShareGrowth,
  requirePositive,
  BLOCKS_PER_30D,
} from "@bitcoinyield/adapters";
import type { Address } from "viem";

// Official Midas registry:
// https://github.com/midas-apps/contracts/blob/main/config/constants/addresses.ts
const ETHEREUM_TOKEN = "0xC8495EAFf71D3A563b906295fCF2f685b1783085";
const ETHEREUM_DATA_FEED = "0xb75B82b2012138815d1A2c4aB5B8b987da043157";
const ETHEREUM_CUSTOM_FEED = "0x3359921992C33ef23169193a6C91F2944A82517C";
const ETHEREUM_DEPOSIT_VAULT = "0xeD22A9861C6eDd4f1292aeAb1E44661D5f3FE65e";
const ETHEREUM_REDEMPTION_VAULT = "0x16d4f955B0aA1b1570Fe3e9bB2f8c19C407cdb67";
const ETHEREUM_OFT = "0xb67f81069e890A1b3e02c7BED3A9f78bA54A445C";

const ROOTSTOCK_TOKEN = "0x7F71f02aE0945364F658860d67dbc10c86Ca3a3C";
const MONAD_TOKEN = "0xF7Cf282eC810fDed974F99c0163E792f432892BC";

// getDataInBase18() is the official Midas NAV, always scaled to 18 decimals.
const NAV_DECIMALS = 18;
const BLOCKS_PER_7D_ETHEREUM = 50_400n;

const dataFeedAbi = [
  {
    inputs: [],
    name: "getDataInBase18",
    outputs: [{ name: "answer", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default defineAdapter({
  slug: "midas-mhyperbtc",
  name: "Midas mHyperBTC",
  url: "https://midas.app/mhyperbtc",
  category: "yield-bearing",
  custody: "custodial",
  audit: {
    latestUrl: "https://docs.midas.app/resources/audits",
  },
  requires: { rpc: ["ethereum"] },

  async fetch() {
    const client = ethereum.getClient();
    const token = ETHEREUM_TOKEN as Address;
    const dataFeed = ETHEREUM_DATA_FEED as Address;

    const [calls, growth7d, growth30d] = await Promise.all([
      ethereum.multicall([
        {
          address: token,
          abi: ethereum.erc20Abi,
          functionName: "totalSupply",
        },
        {
          address: token,
          abi: ethereum.erc20Abi,
          functionName: "decimals",
        },
        {
          address: dataFeed,
          abi: dataFeedAbi,
          functionName: "getDataInBase18",
        },
      ]),
      readShareGrowth({
        client,
        address: dataFeed,
        abi: dataFeedAbi,
        functionName: "getDataInBase18",
        blocksBack: BLOCKS_PER_7D_ETHEREUM,
        decimals: NAV_DECIMALS,
      }),
      readShareGrowth({
        client,
        address: dataFeed,
        abi: dataFeedAbi,
        functionName: "getDataInBase18",
        blocksBack: BLOCKS_PER_30D.ethereum,
        decimals: NAV_DECIMALS,
      }),
    ]);

    const [supplyCall, decimalsCall, navCall] = calls;
    if (
      supplyCall?.status !== "success" ||
      decimalsCall?.status !== "success" ||
      navCall?.status !== "success"
    ) {
      throw new Error(
        `mHyperBTC multicall failed: supply=${supplyCall?.status} decimals=${decimalsCall?.status} nav=${navCall?.status}`,
      );
    }

    const tokenDecimals = decimalsCall.result as number;
    const totalSupplyRaw = supplyCall.result as bigint;
    const navRaw = navCall.result as bigint;

    const totalSupply = math.fromUnits(totalSupplyRaw, tokenDecimals);
    const nav = requirePositive(math.fromUnits(navRaw, NAV_DECIMALS), "nav");
    const tvlBtc = requirePositive(math.mul(totalSupply, nav), "tvlBtc");

    const headline = growth30d.hasBaseline
      ? { window: "30d" as const, growth: growth30d }
      : growth7d.hasBaseline
        ? { window: "7d" as const, growth: growth7d }
        : null;

    if (!headline) {
      throw new Error(
        "mHyperBTC NAV history unavailable on this RPC; need archive access for the 30d or 7d window",
      );
    }

    return [
      {
        symbol: "mHyperBTC",
        tvlBtc,
        rate: headline.growth.apy,
        rateType: "apy",
        metadata: {
          chain: "ethereum",
          tokenAddress: ETHEREUM_TOKEN,
          dataFeedAddress: ETHEREUM_DATA_FEED,
          customFeedAddress: ETHEREUM_CUSTOM_FEED,
          depositVaultAddress: ETHEREUM_DEPOSIT_VAULT,
          redemptionVaultAddress: ETHEREUM_REDEMPTION_VAULT,
          oftAddress: ETHEREUM_OFT,
          satelliteTokens: {
            rootstock: ROOTSTOCK_TOKEN,
            monad: MONAD_TOKEN,
          },
          tokenDecimals,
          totalSupply,
          nav,
          rateWindow: headline.window,
          windowDays: headline.growth.elapsedDays,
          navThen: headline.growth.sharePriceThen,
          apy7d: growth7d.hasBaseline ? growth7d.apy : null,
          apy30d: growth30d.hasBaseline ? growth30d.apy : null,
          linearApr7d: growth7d.hasBaseline ? growth7d.apr : null,
          linearApr30d: growth30d.hasBaseline ? growth30d.apr : null,
          rateSource: `onchain-${headline.window}-nav-apy`,
          source:
            "https://github.com/midas-apps/contracts/blob/main/config/constants/addresses.ts",
        },
      },
    ];
  },
});
