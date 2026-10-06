import { math, requirePositive } from "@bitcoinyield/adapters";
import { LP_TOKEN, VAULT_ID } from "./constants.js";

// Observed daily snapshots. Allow one missed refresh, not indefinite carry-forward.
export const MAX_SNAPSHOT_AGE_MS = 48 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Axiom: missing/invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Axiom: missing/invalid ${field}`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  const result = number(value, field);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`Axiom: invalid ${field}`);
  }
  return result;
}

export function parseSnapshot(data: unknown, now = Date.now()) {
  const response = object(data, "response");
  if (!Array.isArray(response.data) || response.data.length !== 1) {
    throw new Error("Axiom: expected exactly one vault snapshot");
  }
  const row = object(response.data[0], "snapshot");
  if (
    row.vaultId !== VAULT_ID ||
    typeof row.vaultAddress !== "string" ||
    row.vaultAddress.toLowerCase() !== LP_TOKEN.toLowerCase()
  ) {
    throw new Error("Axiom: snapshot is for a different vault");
  }
  const block = object(row.block, "block");
  const blockNumber = integer(block.number, "block.number");
  const timestamp = integer(block.timestamp, "block.timestamp");
  const timestampMs = timestamp * 1000;
  const ageMs = now - timestampMs;
  if (ageMs > MAX_SNAPSHOT_AGE_MS || ageMs < -FUTURE_TOLERANCE_MS) {
    throw new Error("Axiom: stale or future rate snapshot");
  }
  const updatedAt = row.updatedAt;
  const updatedMs = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  if (
    !Number.isFinite(updatedMs) ||
    updatedMs < timestampMs ||
    updatedMs > now + FUTURE_TOLERANCE_MS
  ) {
    throw new Error("Axiom: invalid snapshot update time");
  }
  const aprs = object(row.APRs, "APRs");
  const apys = object(row.APYs, "APYs");
  const fees = object(row.feePercentage, "feePercentage");
  const tvl = object(row.TVL, "TVL");
  if (typeof tvl.token !== "string" || !/^\d+$/.test(tvl.token)) {
    throw new Error("Axiom: invalid WBTC snapshot TVL");
  }

  return {
    netApr: number(aprs.NET, "APRs.NET"),
    grossApr: number(aprs.GROSS, "APRs.GROSS"),
    projectedNetApy: number(apys.NET, "APYs.NET"),
    managementFeePct: number(fees.MANAGEMENT, "management fee"),
    performanceFeePct: number(fees.PERFORMANCE, "performance fee"),
    tvlBtc: requirePositive(math.fromUnits(tvl.token, 8), "snapshot TVL"),
    blockNumber,
    timestamp,
    asOf: new Date(timestampMs).toISOString(),
    updatedAt: updatedAt as string,
  };
}

export type Snapshot = ReturnType<typeof parseSnapshot>;
