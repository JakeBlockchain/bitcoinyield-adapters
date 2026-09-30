/**
 * Syntetika hBTC adapter — ERC-4626 vault on Base.
 *
 * TVL: Syntetika's vault API.
 * APY: 30-day compounded share-price growth (convertToAssets, read on-chain
 *      now and ~30d ago) plus the live Merkl campaign rate, added as Merkl
 *      publishes it. The strategy return compounds into the share price, so
 *      a losing window comes out negative and is published as-is.
 */

import {
  defineAdapter,
  ethereum,
  getEvmClient,
  http,
  math,
  readShareGrowth,
  requireNumber,
  requirePositive,
  type EvmChainConfig,
} from "@bitcoinyield/adapters";

// Syntetika serves its API from this hostname despite the "backup" label —
// api.syntetika.io 404s for these routes (checked 2026-09-16).
const API_BASE = "https://api.backup.syntetika.io";
const MERKL_API = "https://api.merkl.xyz/v4";
const VAULT_ID = "75142b34-9345-48b3-80e5-765b81e75302";
const CHAIN_ID = 8453; // Base
const VAULT_ADDRESS = "0x9C2dCDbDB3F0A0F628D1112bBCABD9AE75353df3";
const VAULT_ADDRESS_LC = VAULT_ADDRESS.toLowerCase();
const ASSET_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
// hBTC and cbBTC are both 8 decimals.
const ONE_SHARE = 100_000_000n;
const ASSET_DECIMALS = 8;
// Base produces a block every 2s, so 1_296_000 blocks ≈ 30 days.
const BASE_BLOCKS_30D = 1_296_000n;

const BASE: EvmChainConfig = {
  id: CHAIN_ID,
  name: "Base",
  rpcEnv: "BITCOINYIELD_RPC_BASE",
  fallbackRpcs: [
    "https://mainnet.base.org",
    "https://base.drpc.org",
    "https://base-rpc.publicnode.com",
  ],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

interface VaultResponse {
  address?: string;
  share_symbol?: string;
  asset_symbol?: string;
  tvl: string | number;
  tvl_usd: string | number;
  share_price: string | number;
  exchange_rate: string | number;
  current_apr: string | number;
  rewards_apy: string | number;
}

interface MerklOpportunity {
  chainId: number;
  identifier: string;
  status: string;
  apr: number;
}

/**
 * Live Merkl campaign APR for the vault, read from Merkl directly so it is
 * independent of Syntetika's self-reported figures. Returns null when Merkl
 * is unreachable or the payload shape is unexpected (caller falls back to
 * the provider-reported rate); an empty campaign list is a real zero.
 */
async function fetchMerklIncentiveApr(): Promise<number | null> {
  try {
    const opportunities = await http.get<MerklOpportunity[]>(
      `${MERKL_API}/opportunities?chainId=${CHAIN_ID}&identifier=${VAULT_ADDRESS}`,
      { retries: 1, timeout: 5_000 },
    );
    if (!Array.isArray(opportunities)) {
      throw new Error("expected an array of opportunities");
    }
    const live = opportunities.filter(
      (o) =>
        o.chainId === CHAIN_ID &&
        typeof o.identifier === "string" &&
        o.identifier.toLowerCase() === VAULT_ADDRESS_LC &&
        typeof o.status === "string" &&
        o.status.toUpperCase() === "LIVE",
    );
    return math.add(...live.map((o) => requireNumber(o.apr, "Merkl apr")));
  } catch (error) {
    console.warn(
      `[syntetika-hbtc] Merkl incentive unavailable, falling back to provider rate: ${error}`,
    );
    return null;
  }
}

export default defineAdapter({
  slug: "syntetika-hbtc",
  name: "Syntetika hBTC",
  url: "https://syntetika.io",
  category: "yield-bearing",
  custody: "custodial",
  requires: { rpc: ["base"] },

  async fetch() {
    const [vault, merklApr, growth] = await Promise.all([
      http.get<VaultResponse>(`${API_BASE}/vault/${VAULT_ID}`),
      fetchMerklIncentiveApr(),
      readShareGrowth({
        client: getEvmClient(BASE),
        address: VAULT_ADDRESS,
        abi: ethereum.erc4626VaultAbi,
        functionName: "convertToAssets",
        args: [ONE_SHARE],
        blocksBack: BASE_BLOCKS_30D,
        decimals: ASSET_DECIMALS,
      }),
    ]);

    if (vault.address?.toLowerCase() !== VAULT_ADDRESS_LC) {
      throw new Error(`Unexpected vault address: ${vault.address}`);
    }
    if (vault.share_symbol?.toLowerCase() !== "hbtc") {
      throw new Error(`Unexpected share symbol: ${vault.share_symbol}`);
    }
    if (vault.asset_symbol?.toLowerCase() !== "cbbtc") {
      throw new Error(`Unexpected asset symbol: ${vault.asset_symbol}`);
    }

    const tvlBtc = requirePositive(vault.tvl, "tvl");
    const tvlUsd = requirePositive(vault.tvl_usd, "tvl_usd");
    const providerIncentiveRate = requireNumber(
      vault.rewards_apy,
      "rewards_apy",
    );
    const sharePrice = requirePositive(vault.share_price, "share_price");
    const exchangeRate = requirePositive(vault.exchange_rate, "exchange_rate");

    if (!growth.hasBaseline) {
      throw new Error(
        "Syntetika hBTC share-price history unavailable on this RPC; need archive access for the 30d window",
      );
    }

    // Strategy return from the share price, then the live Merkl rate so an
    // ended campaign contributes zero (provider rewards_apy only if Merkl is
    // unreachable).
    const strategyApy = growth.apy;
    const incentiveApr = merklApr ?? providerIncentiveRate;
    const apy = math.add(strategyApy, incentiveApr);

    return [
      {
        symbol: "hBTC",
        tvlBtc,
        tvlUsd,
        rate: apy,
        rateType: "apy",
        metadata: {
          chain: "Base",
          chainId: CHAIN_ID,
          vaultAddress: VAULT_ADDRESS,
          assetAddress: ASSET_ADDRESS,
          assetSymbol: "cbBTC",
          rateSource:
            merklApr !== null
              ? "onchain-30d-share-price+merkl-live"
              : "onchain-30d-share-price+provider-rewards-fallback",
          sharePriceCbBtcPerHBtc: sharePrice,
          exchangeRateHBtcPerCbBtc: exchangeRate,
          strategyApy,
          incentiveApr,
          assetsPerShare30dAgo: growth.sharePriceThen,
          windowDays: growth.elapsedDays,
          providerCurrentApr: requireNumber(vault.current_apr, "current_apr"),
        },
      },
    ];
  },
});
