import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTransparencyReport } from "../adapters/lombard-finance/report.js";

const now = Date.parse("2026-09-28T20:00:00Z");
const report = {
  apy: "0.003624889635897219",
  as_of: "2026-09-28T00:00:00Z",
  created_at: "2026-09-28T08:13:56.056511Z",
  id: "cc5b2f29-7ddd-45b5-977b-541787a4b9c4",
};

test("maps the dashboard decimal to percent APY with source provenance", () => {
  const result = parseTransparencyReport({ report }, now);
  assert.equal(result.apyPct, 0.3624889635897219);
  assert.equal(result.apyDecimal, report.apy);
  assert.equal(result.asOf, report.as_of);
  assert.equal(result.createdAt, report.created_at);
  assert.equal(result.id, report.id);
});

test("preserves genuine zero and negative published rates without flooring", () => {
  for (const apy of ["0", "-0.001723180138974853"]) {
    const result = parseTransparencyReport({ report: { ...report, apy } }, now);
    assert.ok(Math.abs(result.apyPct - Number(apy) * 100) < 1e-14);
  }
});

test("rejects missing, blank, malformed and non-finite APY instead of coercing to zero", () => {
  for (const apy of [
    undefined,
    null,
    "",
    " ",
    "NaN",
    "Infinity",
    "1e309",
    "1e308",
    "0x10",
    0,
    {},
    "0.36%",
  ]) {
    assert.throws(() =>
      parseTransparencyReport({ report: { ...report, apy } }, now),
    );
  }
  for (const data of [undefined, null, {}, { report: null }]) {
    assert.throws(() => parseTransparencyReport(data, now));
  }
});

test("rejects stale, missing or future dates and missing report identity", () => {
  for (const field of ["as_of", "created_at"]) {
    for (const value of [
      undefined,
      "",
      "bad",
      "2026-09-24T00:00:00Z",
      "2026-09-29T00:00:00Z",
    ]) {
      assert.throws(() =>
        parseTransparencyReport({ report: { ...report, [field]: value } }, now),
      );
    }
  }
  assert.throws(() =>
    parseTransparencyReport(
      { report: { ...report, created_at: "2026-09-27T00:00:00Z" } },
      now,
    ),
  );
  assert.throws(() =>
    parseTransparencyReport({ report: { ...report, id: "" } }, now),
  );
});
