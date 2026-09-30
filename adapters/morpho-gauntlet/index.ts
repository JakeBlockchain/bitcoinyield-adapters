/**
 * Morpho Gauntlet WBTC Core vault adapter — on-chain TVL and APY.
 *
 * TVL: `totalAssets()`.
 * APY: realized 30-day compounded share-price growth (`convertToAssets`),
 *      the site-wide APY standard. Morpho's forward `netApy` / `apy` from
 *      its GraphQL API are kept in metadata for comparison; they diverge
 *      from the realized figure with idle liquidity and shifting
 *      utilization.
 */

import {
  defineAdapter,
  ethereum,
  http,
  math,
  requirePositive,
  readShareGrowth,
  BLOCKS_PER_30D,
} from "@bitcoinyield/adapters";

const VAULT = "0x443df5eEE3196e9b2Dd77CaBd3eA76C3dee8f9b2";
const ASSET_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"; // WBTC mainnet
const ASSET_DECIMALS = 8; // WBTC has 8 decimals; vault token is 18-decimal.
const CHAIN_ID = 1;

const ONE_SHARE_18_DECIMALS = 10n ** 18n;

const MORPHO_API = "https://api.morpho.org/graphql";
const MORPHO_QUERY = `
  query GetVaultData($address: String!, $chainId: Int!) {
    vaultByAddress(address: $address, chainId: $chainId) {
      state { apy netApy }
    }
  }
`;

interface MorphoData {
  vaultByAddress?: {
    state?: { apy?: number; netApy?: number };
  };
}

export default defineAdapter({
  slug: "morpho-gauntlet",
  name: "Morpho Gauntlet WBTC Core",
  url: "https://app.morpho.org",
  category: "lending",
  custody: "self",
  requires: { rpc: ["ethereum"] },

  async fetch() {
    const [calls, growth, morphoData] = await Promise.all([
      ethereum.multicall([
        {
          address: VAULT,
          abi: ethereum.erc4626VaultAbi,
          functionName: "totalAssets",
        },
        {
          address: VAULT,
          abi: ethereum.erc4626VaultAbi,
          functionName: "decimals",
        },
        {
          address: VAULT,
          abi: ethereum.erc4626VaultAbi,
          functionName: "asset",
        },
        {
          address: VAULT,
          abi: ethereum.erc4626VaultAbi,
          functionName: "maxDeposit",
          args: ["0x0000000000000000000000000000000000000000"],
        },
      ]),
      readShareGrowth({
        client: ethereum.getClient(),
        address: VAULT,
        abi: ethereum.erc4626VaultAbi,
        functionName: "convertToAssets",
        args: [ONE_SHARE_18_DECIMALS],
        blocksBack: BLOCKS_PER_30D.ethereum,
        decimals: ASSET_DECIMALS,
      }),
      // Comparison only — an API outage must not take the row down.
      http
        .graphql<MorphoData>(MORPHO_API, MORPHO_QUERY, {
          address: VAULT,
          chainId: CHAIN_ID,
        })
        .catch((err) => {
          console.warn(`[morpho-gauntlet] Morpho API unavailable: ${err}`);
          return null;
        }),
    ]);

    const [totalAssetsCall, vaultDecimalsCall, assetCall, maxDepositCall] =
      calls;

    if (
      totalAssetsCall?.status !== "success" ||
      vaultDecimalsCall?.status !== "success"
    ) {
      throw new Error(
        `Morpho Gauntlet vault multicall failed: ` +
          `totalAssets=${totalAssetsCall?.status} decimals=${vaultDecimalsCall?.status}`,
      );
    }

    // TVL math uses ASSET decimals (WBTC = 8), NOT vault decimals (18).
    // `totalAssets()` returns the underlying's raw units.
    const tvlBtc = math.fromUnits(
      totalAssetsCall.result as bigint,
      ASSET_DECIMALS,
    );
    requirePositive(tvlBtc, "tvlBtc");

    // If asset() drifts from our constant, ASSET_DECIMALS is wrong and the math breaks.
    const assetAddress =
      assetCall?.status === "success"
        ? (assetCall.result as string)
        : undefined;
    if (
      assetAddress &&
      assetAddress.toLowerCase() !== ASSET_ADDRESS.toLowerCase()
    ) {
      throw new Error(
        `Morpho Gauntlet vault asset() returned ${assetAddress}, expected ${ASSET_ADDRESS}. ` +
          `Update ASSET_ADDRESS + ASSET_DECIMALS if the underlying changed.`,
      );
    }

    // Uncapped MetaMorpho vaults return a huge (but sub-uint256.max) maxDeposit;
    // above 1M BTC (> total WBTC supply) treat as uncapped.
    const maxDepositRaw =
      maxDepositCall?.status === "success"
        ? (maxDepositCall.result as bigint)
        : undefined;
    const maxDepositAsNumber =
      maxDepositRaw !== undefined
        ? math.fromUnits(maxDepositRaw, ASSET_DECIMALS)
        : undefined;
    const maxDepositBtc =
      maxDepositAsNumber !== undefined && maxDepositAsNumber < 1_000_000
        ? maxDepositAsNumber
        : null; // null = effectively uncapped

    if (!growth.hasBaseline) {
      throw new Error(
        "Morpho vault share-price history unavailable on this RPC; need archive access for the 30d window",
      );
    }

    const apiNetApy = morphoData?.vaultByAddress?.state?.netApy;
    const apiGrossApy = morphoData?.vaultByAddress?.state?.apy;

    return [
      {
        symbol: "WBTC",
        tvlBtc,
        rate: growth.apy,
        rateType: "apy",
        metadata: {
          vaultAddress: VAULT,
          assetAddress,
          assetDecimals: ASSET_DECIMALS,
          vaultDecimals: vaultDecimalsCall.result as number,
          sharePrice: growth.sharePriceNow,
          sharePrice30dAgo: growth.sharePriceThen,
          linearApr30d: growth.apr,
          windowDays: growth.elapsedDays,
          grossApy:
            apiGrossApy !== undefined ? math.toPercent(apiGrossApy) : undefined,
          netApy:
            apiNetApy !== undefined ? math.toPercent(apiNetApy) : undefined,
          maxDepositBtc, // null = uncapped
          curator: "Gauntlet",
          yieldMechanism: "lending-vault",
          rateSource: "onchain-30d-share-price-apy",
        },
      },
    ];
  },
});
