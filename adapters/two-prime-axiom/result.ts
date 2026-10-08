import { math, requirePositive } from "@bitcoinyield/adapters";
import type { AdapterResult } from "@bitcoinyield/adapters";
import {
  DEPOSIT_QUEUE,
  LP_TOKEN,
  SNAPSHOT_URL,
  STRATEGY,
  VAULT,
  WBTC,
} from "./constants.js";
import type { Snapshot } from "./snapshot.js";

export interface ChainSnapshot {
  blockNumber: bigint;
  timestamp: bigint;
  contractValue: bigint;
  token: string;
  tranche: string;
  strategy: string;
  managementFee: bigint;
  performanceFee: bigint;
  feeScale: bigint;
  grossApr: bigint;
  defaulted: boolean;
  isEpochRunning: boolean;
  epochEnd: bigint;
}

export function buildResult(
  source: Snapshot,
  chain: ChainSnapshot,
): AdapterResult {
  if (
    chain.token.toLowerCase() !== WBTC.toLowerCase() ||
    chain.tranche.toLowerCase() !== LP_TOKEN.toLowerCase() ||
    chain.strategy.toLowerCase() !== STRATEGY.toLowerCase()
  ) {
    throw new Error(
      "Axiom: vault token/tranche/strategy configuration changed",
    );
  }
  if (chain.defaulted)
    throw new Error("Axiom: vault is defaulted; quoted rate is not usable");
  if (chain.feeScale <= 0n) throw new Error("Axiom: invalid fee scale");
  const grossApr = math.fromUnits(chain.grossApr, 18);
  const managementFeePct = math.toPercent(
    math.div(chain.managementFee, chain.feeScale),
  );
  const performanceFeePct = math.toPercent(
    math.div(chain.performanceFee, chain.feeScale),
  );
  if (performanceFeePct > 100) {
    throw new Error("Axiom: performance fee exceeds 100%");
  }
  // Mirrors the vault's _netGainAfterFees: management fee first, then the
  // performance fee on what remains; nothing is paid when fees exceed the gain.
  const netApr = math.mul(
    Math.max(0, math.sub(grossApr, managementFeePct)),
    math.sub(1, math.div(performanceFeePct, 100)),
  );
  // The API refreshes daily, so it lags on-chain term changes. A mismatch is
  // recorded rather than failing the run; the rate always follows the chain.
  const sourceTermsMatch =
    Math.abs(source.grossApr - grossApr) <= 1e-8 &&
    Math.abs(source.managementFeePct - managementFeePct) <= 1e-8 &&
    Math.abs(source.performanceFeePct - performanceFeePct) <= 1e-8 &&
    Math.abs(source.netApr - netApr) <= 1e-6;
  if (!sourceTermsMatch) {
    console.warn(
      `[two-prime-axiom] Pareto snapshot (net ${source.netApr}%) lags on-chain terms (net ${netApr}%)`,
    );
  }
  if (BigInt(source.blockNumber) > chain.blockNumber) {
    throw new Error("Axiom: RPC block is behind the rate snapshot");
  }
  const chainAsOf = new Date(Number(chain.timestamp) * 1000).toISOString();
  return {
    symbol: "pAXIOMBTC",
    tvlBtc: requirePositive(
      math.fromUnits(chain.contractValue, 8),
      "Axiom contract NAV",
    ),
    // Current net lending APR from on-chain terms, not Pareto's projected APY
    // and not realized NAV growth.
    rate: netApr,
    rateType: "apr",
    metadata: {
      ...(netApr === 0 && { allowZeroRate: true }),
      chain: "ethereum",
      vaultAddress: VAULT,
      tokenAddress: LP_TOKEN,
      underlyingAddress: WBTC,
      strategyAddress: STRATEGY,
      depositQueueAddress: DEPOSIT_QUEUE,
      underlyingDecimals: 8,
      tvlBasis: "onchain-credit-vault-nav",
      tvlSource: "getContractValue()",
      tvlBlockNumber: chain.blockNumber.toString(),
      tvlAsOf: chainAsOf,
      providerTvlBtc: source.tvlBtc,
      rateBasis: "onchain-net-lending-terms",
      rateWindow: "current-loan-terms",
      rateSource: "unscaledApr() net of managementFee() and fee()",
      rateBlockNumber: chain.blockNumber.toString(),
      sourceUrl: SNAPSHOT_URL,
      sourceNetApr: source.netApr,
      sourceTermsMatch,
      sourceAsOf: source.asOf,
      sourceUpdatedAt: source.updatedAt,
      sourceBlockNumber: source.blockNumber,
      sourceFetchedAt: new Date().toISOString(),
      grossApr,
      managementFeePct,
      performanceFeePct,
      projectedNetApy: source.projectedNetApy,
      projectedNetApyBasis: "provider-projected-compounding",
      rewardAsset: "WBTC",
      yieldPayer: "Two Prime",
      isEpochRunning: chain.isEpochRunning,
      epochEnd:
        chain.epochEnd === 0n
          ? null
          : new Date(Number(chain.epochEnd) * 1000).toISOString(),
      firstLossProtection: "legal-agreement-not-onchain-reserve",
    },
  };
}
