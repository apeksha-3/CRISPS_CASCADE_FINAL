// real/net.ts
// Small helpers for talking to public data portals, shared by the discovery
// and fetch scripts. No dependencies: Node's built-in fetch only.
//
// Every raw response is cached under data/real/raw/ (gitignored). If a cached
// file exists we read it instead of the network, so a re-run is offline and
// byte-identical.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const RAW_DIR = join(process.cwd(), "data", "real", "raw");

// Read KEY=value lines from .env without printing anything. Missing file = no keys.
export function readEnv(path = join(process.cwd(), ".env")): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== "") out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export interface CachedResponse {
  url: string; // the request URL WITHOUT tokens (tokens go in headers)
  status: number; // 0 = the request never got an answer (network error or timeout)
  headers: Record<string, string>; // only the few headers we use
  body: string; // for status 0: the error message
  fromCache?: boolean;
}

const KEEP_HEADERS = ["content-type", "x-soda2-fields", "x-soda2-types"];

// Cache file name = readable prefix + hash of the URL, so the same request
// always maps to the same file.
export function cachePath(prefix: string, url: string, dir = RAW_DIR): string {
  const h = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return join(dir, `${prefix}-${h}.json`);
}

export interface GetOptions {
  headers?: Record<string, string>;
  maxTries?: number; // default 5: the first try plus 4 retries
  timeoutMs?: number; // default 30 s per request
  fetchFn?: typeof fetch; // tests pass a fake
  sleep?: (ms: number) => Promise<void>; // tests pass an instant one
  dir?: string; // cache folder
}

function errText(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  return [err.name === "TimeoutError" ? "timeout" : err.message, err.cause?.code, err.cause?.message].filter(Boolean).join(" / ");
}

// GET with cache, a per-request timeout, and retry with exponential backoff
// (2 s, 4 s, 8 s, 16 s) on 429, on 5xx, and on thrown errors (DNS failure,
// reset connection, timeout). Tokens go in headers so they never appear in
// the URL, the logs or the cache.
export async function cachedGet(prefix: string, url: string, opts: GetOptions = {}): Promise<CachedResponse> {
  const { headers = {}, maxTries = 5, timeoutMs = 30_000, fetchFn = fetch, dir = RAW_DIR } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const file = cachePath(prefix, url, dir);
  if (existsSync(file)) return { ...(JSON.parse(readFileSync(file, "utf8")) as CachedResponse), fromCache: true };

  let wait = 2000;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt < maxTries) {
        await sleep(wait);
        wait *= 2;
        continue;
      }
      return { url, status: 0, headers: {}, body: `network error after ${attempt} tries: ${errText(e)}` };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxTries) {
      await sleep(wait);
      wait *= 2;
      continue;
    }
    const kept: Record<string, string> = {};
    for (const k of KEEP_HEADERS) {
      const v = res.headers.get(k);
      if (v !== null) kept[k] = v;
    }
    const out: CachedResponse = { url, status: res.status, headers: kept, body: await res.text() };
    // Only successful responses are cached: a failure must be retried next run.
    if (res.ok) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(out, null, 1));
    }
    return out;
  }
}

// Build a Socrata SoQL URL with URLSearchParams (never by hand).
export function soqlUrl(datasetId: string, params: Record<string, string>): string {
  const u = new URL(`https://data.cityofnewyork.us/resource/${datasetId}.json`);
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}

export function socrataHeaders(env: Record<string, string>): Record<string, string> {
  return env.SOCRATA_APP_TOKEN ? { "X-App-Token": env.SOCRATA_APP_TOKEN } : {};
}
