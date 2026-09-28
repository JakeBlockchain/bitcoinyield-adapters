import { math } from "@bitcoinyield/adapters";

export const TRANSPARENCY_REPORT_URL =
  "https://api.lombard.finance/v2/transparency/reports/latest";
// Daily reports: tolerate delayed publication, but not an indefinitely stale quote.
const MAX_REPORT_AGE_MS = 72 * 60 * 60 * 1000;

export function parseTransparencyReport(data: unknown, now = Date.now()) {
  const report = (data as { report?: Record<string, unknown> } | null)?.report;
  if (!report || typeof report !== "object") {
    throw new Error("LBTC transparency response is missing report");
  }
  const apyDecimal = report.apy;
  if (
    typeof apyDecimal !== "string" ||
    !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(apyDecimal) ||
    !Number.isFinite(Number(apyDecimal))
  ) {
    throw new Error(
      "LBTC transparency report.apy must be a finite decimal string",
    );
  }
  const apyPct = math.toPercent(Number(apyDecimal));
  if (!Number.isFinite(apyPct)) {
    throw new Error("LBTC transparency APY percentage is not finite");
  }
  function timestamp(field: "as_of" | "created_at") {
    const value = report![field];
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
      !Number.isFinite(parsed) ||
      parsed > now ||
      now - parsed > MAX_REPORT_AGE_MS
    ) {
      throw new Error(
        `LBTC transparency report.${field} is invalid, future, or stale`,
      );
    }
    return value;
  }
  const asOf = timestamp("as_of");
  const createdAt = timestamp("created_at");
  if (Date.parse(createdAt) < Date.parse(asOf)) {
    throw new Error("LBTC transparency report predates its as_of timestamp");
  }
  if (typeof report.id !== "string" || !report.id.trim()) {
    throw new Error("LBTC transparency report.id is missing");
  }
  return { apyPct, apyDecimal, asOf, createdAt, id: report.id };
}
