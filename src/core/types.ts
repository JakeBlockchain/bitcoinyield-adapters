export type CustodyModel = "self" | "multisig" | "custodial" | "mpc";

export interface AdapterRequirements {
  rpc?: string[];
  stacks?: boolean;
  apis?: string[];
  /** Named secrets; whitelisted from env as `BITCOINYIELD_${name}` and exposed on `ctx.env`. */
  secrets?: string[];
}

export interface AdapterAuditInfo {
  firms?: string[];
  latestUrl?: string;
}

export interface FetchContext {
  env: Record<string, string | undefined>;
}

/**
 * How `rate` annualizes. `apr` is simple (no compounding); `apy` compounds.
 * Report the one the protocol itself publishes, never a conversion — the
 * main app labels the figure with this.
 *
 * Window standard: an `apy` is the trailing 30-day realized return and is
 * reported as-is, negative included (a losing window is what a depositor
 * would actually get). An `apr` is the trailing 7-day payout rate where the
 * source exposes a window, and never goes below 0.
 */
export type RateType = "apr" | "apy";

export interface AdapterResult {
  symbol: string;
  tvlBtc: number;
  tvlUsd?: number;
  /** Annualized yield in percent (4.2 = 4.2%). */
  rate: number;
  rateType: RateType;
  metadata?: Record<string, unknown>;
}

export interface Adapter {
  slug: string;
  name: string;
  url: string;
  category?: string;
  custody?: CustodyModel;
  audit?: AdapterAuditInfo;
  proofOfReserves?: string;
  schemaVersion?: number;
  requires?: AdapterRequirements;
  fetch: (ctx: FetchContext) => Promise<AdapterResult[]>;
}

export interface MetricRow {
  symbol: string;
  tvlBtc: number;
  tvlUsd: number;
  btcPrice: number;
  rate: number;
  /** `null` only on rows the main app stored before rateType existed. */
  rateType: RateType | null;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export type AdapterRunStatus = "success" | "error";

export interface AdapterRunRecord {
  status: AdapterRunStatus;
  finishedAt: Date;
  durationMs: number;
  rowsInserted?: number;
  rowsDropped?: number;
  lastError?: string | null;
}

export interface Storage {
  getLatest(slug: string): Promise<MetricRow | null>;
  insert(slug: string, rows: MetricRow[]): Promise<void>;
  recordRun(slug: string, record: AdapterRunRecord): Promise<void>;
}

export interface SpikeAlert {
  adapter: string;
  field: "tvlBtc" | "rate";
  oldValue: number;
  newValue: number;
  multiplier: number;
  direction: "up" | "down";
  /** Whether the row was dropped (>= drop threshold) or kept (alert-only band). */
  dropped: boolean;
}

export interface BoundaryAlert {
  adapter: string;
  field: "tvlBtc" | "rate";
  value: number;
  bound: "lower" | "upper";
  threshold: number;
}

export interface StalenessAlert {
  adapter: string;
  lastUpdateAt: Date;
  hoursSilent: number;
}

export interface RegressionAlert {
  adapter: string;
  consecutiveFailures: number;
  lastError: string;
}

export interface Notifier {
  spike(alert: SpikeAlert): Promise<void>;
  boundary(alert: BoundaryAlert): Promise<void>;
  staleness(alert: StalenessAlert): Promise<void>;
  regression(alert: RegressionAlert): Promise<void>;
}
