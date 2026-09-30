/**
 * Kraken Bitcoin Earn adapter — BoringVault on Ink L2 (chain id 57073).
 *
 * TVL: vault totalSupply × accountant getRate (rate = BTC per share).
 * APY: 30-day compounded accountant-rate growth via readShareGrowth. The
 *      rate is net of fees and compounds into the share price, so it is an
 *      APY and can go negative. Kraken's Dune dashboard shows a 7D window;
 *      we report 30D, the site-wide APY standard. No history, no rate: the
 *      run fails rather than storing a guess.
 */

import {
  defineAdapter,
  getEvmClient,
  math,
  requirePositive,
  readShareGrowth,
  type EvmChainConfig,
} from "@bitcoinyield/adapters";

const BORING_VAULT = "0x7Dee0120739b7ec048B469939EFB178ADbbB19B2";
const ACCOUNTANT = "0x4Bb6C416a00561ad6657110b76552c42d55Ff1d6";

// Ink produces ~1 block/sec, so 2_592_000 blocks ≈ 30 days. readShareGrowth
// annualizes by actual block timestamps, so drift only widens the window.
const INK_BLOCKS_30D = 2_592_000n;

const INK: EvmChainConfig = {
  id: 57073,
  name: "Ink",
  rpcEnv: "BITCOINYIELD_RPC_INK",
  fallbackRpcs: ["https://rpc-gel.inkonchain.com", "https://ink.drpc.org"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const vaultAbi = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const accountantAbi = [
  {
    inputs: [],
    name: "getRate",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default defineAdapter({
  slug: "kraken-bitcoin-earn",
  name: "Kraken Bitcoin Earn",
  url: "https://www.kraken.com/earn",
  category: "yield-bearing",
  custody: "custodial",
  requires: { rpc: ["ink"] },

  async fetch() {
    const client = getEvmClient(INK);

    const [totalSupply, shareDecimals, rateDecimals] = await Promise.all([
      client.readContract({
        address: BORING_VAULT,
        abi: vaultAbi,
        functionName: "totalSupply",
      }),
      client.readContract({
        address: BORING_VAULT,
        abi: vaultAbi,
        functionName: "decimals",
      }),
      client.readContract({
        address: ACCOUNTANT,
        abi: accountantAbi,
        functionName: "decimals",
      }),
    ]);

    const growth = await readShareGrowth({
      client,
      address: ACCOUNTANT,
      abi: accountantAbi,
      functionName: "getRate",
      blocksBack: INK_BLOCKS_30D,
      decimals: Number(rateDecimals),
    });

    const shares = math.fromUnits(totalSupply, Number(shareDecimals));
    const rateNow = requirePositive(growth.sharePriceNow, "getRate");
    const tvlBtc = requirePositive(math.mul(shares, rateNow), "tvlBtc");

    if (!growth.hasBaseline) {
      throw new Error(
        "Kraken accountant rate history unavailable on this RPC; need archive access for the 30d window",
      );
    }

    return [
      {
        symbol: "BTC",
        tvlBtc,
        rate: growth.apy,
        rateType: "apy",
        metadata: {
          vaultAddress: BORING_VAULT,
          accountantAddress: ACCOUNTANT,
          chainId: INK.id,
          rate: rateNow,
          rate30dAgo: growth.sharePriceThen,
          windowDays: growth.elapsedDays,
          linearApr30d: growth.apr,
          rateSource: "onchain-30d-rate-apy",
        },
      },
    ];
  },
});
