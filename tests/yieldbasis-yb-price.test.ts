import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  fetchYbPriceUsd,
  parseYbPriceFromProtocolMetrics,
} from "../adapters/yieldbasis/token-adapter.js";
import * as prices from "../src/core/utils/prices.js";

const NOW_MS = 1_790_683_000_000;
const FRESH_BUCKET = Math.floor(NOW_MS / 1000) - 3600;

const metrics = (data: Record<string, unknown>, success = true) => ({
  success,
  data: { bucketStart: FRESH_BUCKET, ...data },
});

test("parses the 1e18-scaled YB price", () => {
  const price = parseYbPriceFromProtocolMetrics(
    metrics({ ybPriceRaw: "90013468549039229" }),
    NOW_MS,
  );
  assert.equal(price, 0.090013468549039229);
});

test("rejects a stale bucket", () => {
  assert.throws(
    () =>
      parseYbPriceFromProtocolMetrics(
        {
          success: true,
          data: {
            bucketStart: FRESH_BUCKET - 7 * 3600,
            ybPriceRaw: "90013468549039229",
          },
        },
        NOW_MS,
      ),
    /stale/,
  );
});

test("rejects a decimal, zero or missing price", () => {
  for (const ybPriceRaw of ["0.09", "0", undefined]) {
    assert.throws(() =>
      parseYbPriceFromProtocolMetrics(metrics({ ybPriceRaw }), NOW_MS),
    );
  }
  assert.throws(
    () =>
      parseYbPriceFromProtocolMetrics(
        metrics({ ybPriceRaw: "1" }, false),
        NOW_MS,
      ),
    /malformed/,
  );
});

const realFetch = globalThis.fetch;

function stubFetch(responses: Record<string, () => Response>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const respond = responses[new URL(url).hostname];
    if (!respond) throw new Error(`unexpected fetch: ${url}`);
    return respond();
  }) as typeof fetch;
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => () => new Response("", { status: code });

beforeEach(() => prices.resetPriceCache());
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("uses the Yield Basis API first", async () => {
  stubFetch({
    "api.yieldbasis.com": json({
      success: true,
      data: {
        bucketStart: Math.floor(Date.now() / 1000) - 600,
        ybPriceRaw: "90013468549039229",
      },
    }),
  });
  assert.equal(await fetchYbPriceUsd(), 0.090013468549039229);
});

test("falls back to Coinbase, then CoinGecko", async () => {
  stubFetch({
    "api.yieldbasis.com": status(503),
    "api.coinbase.com": json({ data: { amount: "0.0928" } }),
  });
  assert.equal(await fetchYbPriceUsd(), 0.0928);

  stubFetch({
    "api.yieldbasis.com": status(503),
    "api.coinbase.com": status(404),
    "api.coingecko.com": json({ "yield-basis": { usd: 0.0931 } }),
  });
  assert.equal(await fetchYbPriceUsd(), 0.0931);
});

test("throws naming every source when all fail", async () => {
  stubFetch({
    "api.yieldbasis.com": status(503),
    "api.coinbase.com": status(404),
    "api.coingecko.com": status(403),
  });
  await assert.rejects(fetchYbPriceUsd(), /yieldbasis.*coinbase.*coingecko/);
});
