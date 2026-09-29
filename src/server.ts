/**
 * Standalone Inngest microservice. Holds no DB credentials — POSTs metrics
 * and status to the main BitcoinYield app via HttpStorage, and pages
 * Discord locally so alerts keep working even when the main app is down.
 *
 * Run via `pnpm start` (Node http server on $PORT) or via Vercel
 * (`api/inngest.ts` re-exports `inngestHandler`).
 */

import { existsSync } from "node:fs";

if (existsSync(".env.local")) {
  (process as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
    ".env.local",
  );
}

import { Inngest } from "inngest";
import { createServer, serve } from "inngest/node";

import { adapters } from "./adapters-registry.js";
import { runStalenessMonitor } from "./core/monitor/staleness.js";
import { DiscordNotifier } from "./core/notifications/discord.js";
import { runAdapter } from "./core/runAdapter.js";
import { HttpStorage } from "./core/storage/http.js";
import * as prices from "./core/utils/prices.js";
import { LoggingStorage } from "./core/storage/logging.js";
import type { Adapter, Storage } from "./core/types.js";

export const inngest = new Inngest({ id: "bitcoinyield-adapters" });

// Storage mode: `log` writes structured lines to stdout instead of POSTing
// to the main app. Used for testing deploys before the main-app endpoints
// are live. Any other value (or unset) uses HttpStorage.
const storage: Storage =
  process.env.BITCOINYIELD_STORAGE_MODE === "log"
    ? new LoggingStorage()
    : new HttpStorage({
        baseUrl: requireEnv("BITCOINYIELD_API_URL"),
        adapterKey: requireEnv("BITCOINYIELD_ADAPTER_KEY"),
      });

// eslint-disable-next-line no-console
console.log(
  `[bitcoinyield-adapters] storage=${storage instanceof LoggingStorage ? "log" : "http"}`,
);

const notifier = new DiscordNotifier({
  fallback: process.env.DISCORD_WEBHOOK,
});

const RETRIES = 3 as const;
const CONCURRENCY_LIMIT = 1;
const SCHEDULE_CRON = "0 * * * *";
const STALENESS_CRON = "30 * * * *";

const adapterList = Object.values(adapters);

const adapterFunctions = adapterList.map((adapter: Adapter) =>
  inngest.createFunction(
    {
      id: `run-adapter-${adapter.slug}`,
      retries: RETRIES,
      concurrency: { limit: CONCURRENCY_LIMIT },
      onFailure: async ({ error }) => {
        await notifier.regression({
          adapter: adapter.slug,
          consecutiveFailures: RETRIES + 1,
          lastError: error instanceof Error ? error.message : String(error),
        });
      },
    },
    { event: `adapter/${adapter.slug}.run` },
    async ({ event, step }) =>
      step.run("run", () =>
        runAdapter(adapter, {
          storage,
          notifier,
          // Fetched once by the scheduler; absent on dashboard-invoked
          // events or when every price source failed, and runAdapter
          // then fetches its own.
          btcPrice:
            typeof event.data?.btcPrice === "number"
              ? event.data.btcPrice
              : undefined,
          // Pin to the event, never the wall clock: the main app dedups on
          // (slug, timestamp), so a retried step must produce the same
          // timestamp. event.ts covers dashboard-invoked events that omit
          // triggeredAt.
          now:
            typeof event.data?.triggeredAt === "number"
              ? new Date(event.data.triggeredAt)
              : new Date(event.ts ?? Date.now()),
        }),
      ),
  ),
);

const scheduler = inngest.createFunction(
  { id: "schedule-adapters" },
  { cron: SCHEDULE_CRON },
  async ({ step }) => {
    // One price for the whole fan-out: per-adapter fetches from ~20 cold
    // Lambdas got 429'd by CoinGecko. A failure here doesn't block the run;
    // adapters then fetch their own (through the same source fallbacks).
    const btcPrice = await step.run("btc-price", async () => {
      try {
        return await prices.getBtc();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[schedule-adapters] BTC price unavailable, adapters will fetch their own: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    });
    const events = adapterList.map((a) => ({
      name: `adapter/${a.slug}.run`,
      data: { triggeredAt: Date.now(), btcPrice },
    }));
    await step.sendEvent("fan-out", events);
    return {
      fannedOut: events.length,
      adapters: adapterList.map((a) => a.slug),
    };
  },
);

const stalenessMonitor = inngest.createFunction(
  { id: "monitor-stale-adapters" },
  { cron: STALENESS_CRON },
  async () =>
    runStalenessMonitor(storage, notifier, {
      slugs: adapterList.map((a) => a.slug),
    }),
);

export const functions = [...adapterFunctions, scheduler, stalenessMonitor];

export const inngestHandler = serve({ client: inngest, functions });

if (isMainModule(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createServer({ client: inngest, functions }).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[bitcoinyield-adapters] inngest server listening on :${port} ` +
        `(${functions.length} functions)`,
    );
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) return false;
  const entry = new URL(`file://${process.argv[1]}`).href;
  return metaUrl === entry;
}
