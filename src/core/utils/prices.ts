/**
 * Canonical USD price helpers. BTC comes from CoinGecko (the same URL the
 * main BitcoinYield app uses, so the two services see compatible numbers),
 * falling back to exchange spot tickers when CoinGecko fails.
 *
 * The in-process cache is mostly a no-op on Vercel serverless (each
 * invocation is its own Lambda), so the hourly scheduler fetches BTC once
 * and passes it on every adapter event; runAdapter primes this cache with
 * it, and adapters calling getBtc() themselves read that value instead of
 * each hitting CoinGecko (the keyless API 429s the fan-out on shared IPs).
 *
 * Concurrent cache misses share one in-flight request.
 */

import { get } from "./http.js";

const COINGECKO_BTC_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";

interface PriceSource {
  label: string;
  url: string;
  extract: (data: unknown) => number | string | undefined;
}

// Tried in order. One retry each: on a 429 the next source is a better bet
// than backing off against the same limit.
const BTC_SOURCES: PriceSource[] = [
  {
    label: "coingecko",
    url: COINGECKO_BTC_PRICE_URL,
    extract: (data) => (data as { bitcoin?: { usd?: number } }).bitcoin?.usd,
  },
  {
    label: "coinbase",
    url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    extract: (data) => (data as { data?: { amount?: string } }).data?.amount,
  },
  {
    label: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    // c = [last trade price, lot volume]
    extract: (data) =>
      (data as { result?: { XXBTZUSD?: { c?: string[] } } }).result?.XXBTZUSD
        ?.c?.[0],
  },
  {
    label: "bitstamp",
    url: "https://www.bitstamp.net/api/v2/ticker/btcusd/",
    extract: (data) => (data as { last?: string }).last,
  },
];

const BTC_KEY = "coingecko:bitcoin";

const cache = new Map<string, { price: number; cachedAt: number }>();
const inflight = new Map<string, Promise<number>>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key: string): number | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.price;
}

function requireValidPrice(raw: unknown, label: string): number {
  const price = typeof raw === "string" ? parseFloat(raw) : raw;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price returned from ${label}: ${String(raw)}`);
  }
  return price;
}

function fetchShared(
  key: string,
  load: () => Promise<number>,
): Promise<number> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = load()
    .then((price) => {
      cache.set(key, { price, cachedAt: Date.now() });
      return price;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

async function fetchBtcFromSources(): Promise<number> {
  const failures: string[] = [];
  for (const source of BTC_SOURCES) {
    try {
      const data = await get(source.url, { retries: 1 });
      return requireValidPrice(
        source.extract(data),
        `${source.label} (bitcoin)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${source.label}: ${message}`);
      // eslint-disable-next-line no-console
      console.warn(`[prices] BTC from ${source.label} failed: ${message}`);
    }
  }
  throw new Error(`All BTC price sources failed — ${failures.join("; ")}`);
}

export async function getBtc(): Promise<number> {
  const cached = getCached(BTC_KEY);
  if (cached !== null) return cached;
  return fetchShared(BTC_KEY, fetchBtcFromSources);
}

/**
 * Seed the BTC cache with a price fetched elsewhere (the scheduler's), so
 * getBtc() calls during this run don't go back to the network.
 */
export function primeBtc(price: number): void {
  cache.set(BTC_KEY, {
    price: requireValidPrice(price, "primeBtc"),
    cachedAt: Date.now(),
  });
}

/** Test hook: forget cached and in-flight prices. */
export function resetPriceCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Spot price for any token by its CoinGecko id (e.g. `'yield-basis'`).
 */
export async function getToken(coingeckoId: string): Promise<number> {
  const key = `coingecko:${coingeckoId}`;
  const cached = getCached(key);
  if (cached !== null) return cached;

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coingeckoId)}&vs_currencies=usd`;
  return fetchShared(key, async () => {
    const data = await get(url);
    return requireValidPrice(
      (data as Record<string, { usd?: number }>)[coingeckoId]?.usd,
      `CoinGecko (${coingeckoId})`,
    );
  });
}
