import type {
  Adapter,
  Storage,
  Notifier,
  FetchContext,
  MetricRow,
} from "./types.js";
import { normalize } from "./pipeline/normalize.js";
import { applyBoundaries } from "./pipeline/boundaries.js";
import { spikeGuard } from "./pipeline/spikeGuard.js";
import * as prices from "./utils/prices.js";
import { NoopStorage } from "./storage/noop.js";
import { NoopNotifier } from "./notifications/noop.js";

export interface RunOptions {
  storage?: Storage;
  notifier?: Notifier;
  btcPrice?: number;
  now?: Date;
  /** Skip persistence; still runs the full pipeline. Used by `cli validate`. */
  dryRun?: boolean;
}

export interface RunResult {
  status: "success" | "error";
  inserted: MetricRow[];
  dropped: Array<{ row: MetricRow; reason: string }>;
  error?: string;
}

export async function runAdapter(
  adapter: Adapter,
  options: RunOptions = {},
): Promise<RunResult> {
  const storage = options.storage ?? new NoopStorage();
  const notifier = options.notifier ?? new NoopNotifier();
  const startedAt = new Date();
  const now = options.now ?? new Date();

  try {
    const ctx = buildFetchContext(adapter);
    // Adapters that value TVL via prices.getBtc() read this instead of
    // fetching their own.
    if (options.btcPrice !== undefined) prices.primeBtc(options.btcPrice);

    const [raw, btcPrice, previous] = await Promise.all([
      adapter.fetch(ctx),
      options.btcPrice !== undefined
        ? Promise.resolve(options.btcPrice)
        : prices.getBtc(),
      storage.getLatest(adapter.slug),
    ]);

    const normalized = normalize(raw, adapter, btcPrice, now);
    const { kept: bounded, dropped: outOfBounds } = await applyBoundaries(
      normalized,
      adapter.slug,
      notifier,
    );

    const { kept: safe, dropped: spikeDropped } = await spikeGuard(
      bounded,
      previous,
      adapter.slug,
      notifier,
    );

    if (!options.dryRun && safe.length > 0) {
      await storage.insert(adapter.slug, safe);
    }

    if (!options.dryRun) {
      await storage.recordRun(adapter.slug, {
        status: "success",
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        rowsInserted: safe.length,
        rowsDropped: outOfBounds.length + spikeDropped.length,
        lastError: null,
      });
    }

    return {
      status: "success",
      inserted: safe,
      dropped: [...outOfBounds, ...spikeDropped],
    };
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (!options.dryRun) {
      try {
        await storage.recordRun(adapter.slug, {
          status: "error",
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt.getTime(),
          lastError: message.slice(0, 4000),
        });
      } catch (recordErr) {
        // A status-write failure must not mask the root-cause error below.
        // eslint-disable-next-line no-console
        console.error(
          `[runAdapter] recordRun(${adapter.slug}) failed while reporting an error: ` +
            `${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
        );
      }
    }
    throw err;
  }
}

function buildFetchContext(adapter: Adapter): FetchContext {
  const allowedSecrets = adapter.requires?.secrets ?? [];
  const env: Record<string, string | undefined> = {};
  for (const key of allowedSecrets) {
    env[key] = process.env[`BITCOINYIELD_${key}`];
  }
  return { env };
}
