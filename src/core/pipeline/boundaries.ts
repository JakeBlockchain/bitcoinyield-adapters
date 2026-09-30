import type { MetricRow, Notifier } from "../types.js";

export const BOUNDARIES = {
  // Lower bound is permissive — some legitimate adapters report tiny TVL
  // (e.g. Stacks STX-stacking reserve between distribution cycles).
  tvlBtc: { lb: 0.0001, ub: 5_000_000 },
  // An APY is a trailing realized return, so a strategy that lost money over
  // the window is negative — and a depositor withdrawing then gets back less
  // than they put in. An APR is a simple payout rate and never goes below 0.
  // -100% is the floor of any real return.
  rate: {
    apr: { lb: 0, ub: 1_000 },
    apy: { lb: -100, ub: 1_000 },
  },
};

export interface BoundariesResult {
  kept: MetricRow[];
  dropped: Array<{ row: MetricRow; reason: string }>;
}

export async function applyBoundaries(
  rows: MetricRow[],
  adapterSlug: string,
  notifier: Notifier,
): Promise<BoundariesResult> {
  const kept: MetricRow[] = [];
  const dropped: Array<{ row: MetricRow; reason: string }> = [];

  for (const row of rows) {
    const violation = check(row);
    if (!violation) {
      kept.push(row);
      continue;
    }
    await notifier.boundary({ adapter: adapterSlug, ...violation });
    dropped.push({
      row,
      reason: `${violation.field} ${violation.value} ${violation.bound === "lower" ? "below" : "above"} ${violation.bound} bound ${violation.threshold}`,
    });
  }

  return { kept, dropped };
}

function check(row: MetricRow): {
  field: "tvlBtc" | "rate";
  value: number;
  bound: "lower" | "upper";
  threshold: number;
} | null {
  if (row.tvlBtc < BOUNDARIES.tvlBtc.lb) {
    return {
      field: "tvlBtc",
      value: row.tvlBtc,
      bound: "lower",
      threshold: BOUNDARIES.tvlBtc.lb,
    };
  }
  if (row.tvlBtc > BOUNDARIES.tvlBtc.ub) {
    return {
      field: "tvlBtc",
      value: row.tvlBtc,
      bound: "upper",
      threshold: BOUNDARIES.tvlBtc.ub,
    };
  }
  // normalize always labels fresh rows; null only exists on stored legacy
  // rows, which read as apr downstream.
  const rateBounds = BOUNDARIES.rate[row.rateType ?? "apr"];
  if (row.rate < rateBounds.lb) {
    return {
      field: "rate",
      value: row.rate,
      bound: "lower",
      threshold: rateBounds.lb,
    };
  }
  if (row.rate > rateBounds.ub) {
    return {
      field: "rate",
      value: row.rate,
      bound: "upper",
      threshold: rateBounds.ub,
    };
  }
  return null;
}
