import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as prices from "../src/core/utils/prices.js";

const realFetch = globalThis.fetch;
let calls: string[] = [];

function stubFetch(responses: Record<string, () => Response>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const host = new URL(url).hostname;
    const respond = responses[host];
    if (!respond) throw new Error(`unexpected fetch: ${url}`);
    return respond();
  }) as typeof fetch;
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => () => new Response("", { status: code });

beforeEach(() => {
  calls = [];
  prices.resetPriceCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("uses CoinGecko when it answers", async () => {
  stubFetch({ "api.coingecko.com": json({ bitcoin: { usd: 83_700 } }) });
  assert.equal(await prices.getBtc(), 83_700);
  assert.equal(calls.length, 1);
});

test("falls back to Coinbase when CoinGecko rate-limits", async () => {
  stubFetch({
    "api.coingecko.com": status(429),
    "api.coinbase.com": json({ data: { amount: "83739.985" } }),
  });
  assert.equal(await prices.getBtc(), 83739.985);
});

test("falls through to Kraken, then Bitstamp", async () => {
  stubFetch({
    "api.coingecko.com": status(429),
    "api.coinbase.com": status(503),
    "api.kraken.com": json({
      error: [],
      result: { XXBTZUSD: { c: ["83740.4", "0.1"] } },
    }),
  });
  assert.equal(await prices.getBtc(), 83740.4);

  prices.resetPriceCache();
  stubFetch({
    "api.coingecko.com": status(429),
    "api.coinbase.com": status(403),
    "api.kraken.com": json({ error: ["EGeneral:Temporary lockout"] }),
    "www.bitstamp.net": json({ last: "83742.71" }),
  });
  assert.equal(await prices.getBtc(), 83742.71);
});

test("throws naming every source when all fail", async () => {
  stubFetch({
    "api.coingecko.com": status(429),
    "api.coinbase.com": status(429),
    "api.kraken.com": status(429),
    "www.bitstamp.net": status(429),
  });
  await assert.rejects(
    prices.getBtc(),
    /coingecko.*coinbase.*kraken.*bitstamp/,
  );
});

test("a primed price is served without any fetch", async () => {
  stubFetch({});
  prices.primeBtc(84_000);
  assert.equal(await prices.getBtc(), 84_000);
  assert.equal(calls.length, 0);
});

test("primeBtc rejects a non-positive price", () => {
  assert.throws(() => prices.primeBtc(0), /Invalid price/);
});
