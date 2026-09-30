/**
 * Lombard Earn adapter (LBTCv vault).
 *
 * TVL: Sevenseas vault feed (latest daily row).
 * APY: 30-day compounded share-price growth from the same feed's daily rows,
 *      plus the BARD incentive component of Lombard's analytics summary,
 *      added as Lombard publishes it. The vault part compounds into the
 *      share price, so a losing window comes out negative. Lombard's own
 *      vault figure (window unpublished) is kept in metadata for comparison.
 */

import {
  defineAdapter,
  http,
  math,
  parseNumber,
  requireNumber,
  requirePositive,
} from "@bitcoinyield/adapters";

const APY_URL =
  "https://mainnet.prod.lombard.finance/api/v1/analytics/btce/apy/summary";
const VAULT_ADDRESS = "0x5401b8620E5FB570064CA9114fd1e135fd77D57c";
const VAULT_FEED = `https://bff.prod.lombard-fi.com/sevenseas-api/daily-data/all/${VAULT_ADDRESS}`;

const APY_WINDOW_DAYS = 30;
// Daily rows; a much shorter window means missing days.
const MIN_WINDOW_DAYS = 25;
const DAY_SECONDS = 86_400;

interface ApySummary {
  snapshot?: {
    total_apy?: number;
    breakdown?: Array<{ apy: number; asset: string }>;
  };
}

interface VaultEntry {
  tvl: string;
  total_assets: string;
  price_usd: string;
  share_price: number | string;
  unix_seconds: number;
}

export default defineAdapter({
  slug: "lombard-earn",
  name: "Lombard Earn",
  url: "https://www.lombard.finance/app/earn/",
  category: "yield-bearing",
  custody: "multisig",

  async fetch() {
    // A day of slack so the baseline row exists even if today's is late.
    const fromSeconds =
      Math.floor(Date.now() / 1000) - (APY_WINDOW_DAYS + 1) * DAY_SECONDS;
    const [apyData, vaultData] = await Promise.all([
      http.get<ApySummary>(APY_URL),
      http.get<VaultEntry[]>(`${VAULT_FEED}/${fromSeconds}/latest`),
    ]);

    if (!Array.isArray(vaultData) || vaultData.length === 0) {
      throw new Error("Lombard Earn vault feed returned empty");
    }
    const rows = [...vaultData].sort((a, b) => b.unix_seconds - a.unix_seconds);
    const latest = rows[0]!;
    const targetSeconds = latest.unix_seconds - APY_WINDOW_DAYS * DAY_SECONDS;
    const baseline = rows.find((r) => r.unix_seconds <= targetSeconds);
    if (!baseline) {
      throw new Error(`Lombard Earn vault feed has no row ${APY_WINDOW_DAYS}d back`);
    }
    const windowDays =
      (latest.unix_seconds - baseline.unix_seconds) / DAY_SECONDS;
    if (windowDays < MIN_WINDOW_DAYS) {
      throw new Error(`Lombard Earn window too short (${windowDays} days)`);
    }

    const tvlUsd = requirePositive(latest.tvl, "lombard-earn.tvl");
    const tvlBtc = requirePositive(
      latest.total_assets,
      "lombard-earn.total_assets",
    );
    const sharePrice = requirePositive(latest.share_price, "share_price");
    const sharePriceThen = requirePositive(
      baseline.share_price,
      "baseline share_price",
    );
    const vaultApy = math.mul(
      math.sub(
        Math.pow(math.div(sharePrice, sharePriceThen), 365 / windowDays),
        1,
      ),
      100,
    );

    const breakdown = apyData?.snapshot?.breakdown;
    if (!Array.isArray(breakdown)) {
      throw new Error("Lombard Earn APY summary has no breakdown");
    }
    const component = (asset: string) =>
      breakdown.find((b) => b.asset === asset)?.apy;
    // An ended campaign drops out of the breakdown: a real zero.
    const incentiveApy = math.toPercent(
      requireNumber(component("ASSET_BARD") ?? 0, "ASSET_BARD apy"),
    );

    return [
      {
        symbol: "LBTCv",
        tvlBtc,
        tvlUsd,
        rate: math.add(vaultApy, incentiveApy),
        rateType: "apy",
        metadata: {
          vaultApy,
          incentiveApy,
          reportedVaultApy:
            component("ASSET_LBTCV") !== undefined
              ? math.toPercent(component("ASSET_LBTCV")!)
              : null,
          reportedTotalApy:
            apyData.snapshot?.total_apy !== undefined
              ? math.toPercent(apyData.snapshot.total_apy)
              : null,
          vaultAddress: VAULT_ADDRESS,
          sharePrice,
          sharePrice30dAgo: sharePriceThen,
          windowDays,
          vaultPriceUsd: parseNumber(latest.price_usd),
          rateSource: "sevenseas-30d-share-price+lombard-bard",
        },
      },
    ];
  },
});
