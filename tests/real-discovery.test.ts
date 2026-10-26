// tests/real-discovery.test.ts
// Phase 7: the discovery helpers. Timestamp inference from sample values, and
// the fetch retry/timeout/cache logic, with a fake fetch (no network).

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferTimestampColumns, looksLikeIsoDate, pickDateField } from "../real/infer";
import { cachedGet } from "../real/net";

describe("timestamp inference without type headers", () => {
  it("recognises the ISO forms the portals use, and nothing else", () => {
    for (const v of ["2021-09-01", "2021-09-01T21:30:00.000", "2021-09-01T21:30:00", "2021-09-01 21:30", "2021-09-02T01:30:00Z", "2021-09-01T21:30:00-04:00"])
      expect(looksLikeIsoDate(v), v).toBe(true);
    for (const v of ["09/01/2021", "21:30", "2021", "BROOKLYN", 20210901, null, "2021-09-01 later"])
      expect(looksLikeIsoDate(v), String(v)).toBe(false);
  });

  it("a column is a timestamp only if every non-empty value is an ISO date", () => {
    const rows = [
      { created_date: "2021-09-01T21:30:00.000", closed_date: "", crash_time: "21:30", borough: "QUEENS" },
      { created_date: "2021-09-01T22:00:00.000", closed_date: "2021-09-03T10:00:00.000", crash_time: "22:00", borough: "BRONX" },
      { created_date: "2021-09-02T01:00:00.000", odd: "2021-09-02T01:00:00.000" },
      { odd: "not a date" },
    ];
    expect(inferTimestampColumns(rows)).toEqual(["closed_date", "created_date"]);
    expect(pickDateField(inferTimestampColumns(rows))).toBe("created_date");
    expect(pickDateField([])).toBeUndefined();
  });
});

function fakeResponse(status: number, body = "[]"): Response {
  return new Response(body, { status, headers: { "x-soda2-fields": '["a"]', "x-soda2-types": '["text"]' } });
}

describe("cachedGet: retry, timeout and cache", () => {
  const noSleep = async () => {};

  it("retries thrown fetch errors with doubling backoff, then succeeds and caches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raw-"));
    const waits: number[] = [];
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls <= 2) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return fakeResponse(200, '[{"a":"1"}]');
    }) as unknown as typeof fetch;
    const r = await cachedGet("t", "https://example.test/x", { fetchFn, dir, sleep: async (ms) => void waits.push(ms) });
    expect(r.status).toBe(200);
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 4000]);
    expect(r.headers["x-soda2-fields"]).toBe('["a"]');
    // second call reads the cache, no fetch
    const again = await cachedGet("t", "https://example.test/x", { fetchFn: (() => { throw new Error("no network"); }) as unknown as typeof fetch, dir });
    expect(again.fromCache).toBe(true);
    expect(again.body).toBe(r.body);
  });

  it("retries 429 and 5xx, but not 4xx; failures are never cached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raw-"));
    const seq = [429, 503, 200];
    let i = 0;
    const r = await cachedGet("t", "https://example.test/y", { fetchFn: (async () => fakeResponse(seq[i++])) as unknown as typeof fetch, dir, sleep: noSleep });
    expect(r.status).toBe(200);
    expect(i).toBe(3);

    let n = 0;
    const bad = await cachedGet("t", "https://example.test/z", { fetchFn: (async () => (n++, fakeResponse(404, "nope"))) as unknown as typeof fetch, dir, sleep: noSleep });
    expect(bad.status).toBe(404);
    expect(n).toBe(1);
    expect(readdirSync(dir).length).toBe(1); // only the 200 above
  });

  it("gives up after maxTries thrown errors with status 0 and the error text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raw-"));
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND data.cityofnewyork.us" } });
    }) as unknown as typeof fetch;
    const r = await cachedGet("t", "https://example.test/w", { fetchFn, dir, sleep: noSleep, maxTries: 5 });
    expect(calls).toBe(5);
    expect(r.status).toBe(0);
    expect(r.body).toMatch(/after 5 tries.*ENOTFOUND/);
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });

  it("passes a 30 s timeout signal to every request, and a timeout counts as a retryable error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raw-"));
    const signals: AbortSignal[] = [];
    let calls = 0;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      calls++;
      if (calls === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return fakeResponse(200);
    }) as unknown as typeof fetch;
    const r = await cachedGet("t", "https://example.test/v", { fetchFn, dir, sleep: noSleep });
    expect(r.status).toBe(200);
    expect(signals).toHaveLength(2);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);

    // a real short timeout against a fetch that never answers
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej((init.signal as AbortSignal).reason)))) as unknown as typeof fetch;
    const t = await cachedGet("t", "https://example.test/hang", { fetchFn: hang, dir, sleep: noSleep, maxTries: 2, timeoutMs: 20 });
    expect(t.status).toBe(0);
    expect(t.body).toMatch(/timeout/);
  });
});
