// real/load.ts
// Read the cached raw files (data/real/raw) written by scripts/real/fetch.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "./csv";
import { RAW_DIR } from "./net";

const memo = new Map<string, unknown>();

// REAL_RAW_DIR lets a test point at a tiny fixture folder instead of the 300 MB cache.
const rawDir = () => process.env.REAL_RAW_DIR ?? RAW_DIR;

function read(file: string): string {
  const path = join(rawDir(), file);
  if (!existsSync(path)) throw new Error(`missing ${path}. Run: npx tsx scripts/real/fetch.ts`);
  return readFileSync(path, "utf8");
}

export function loadJson(dataset: string, windowId: string): Record<string, string>[] {
  const key = `${dataset}__${windowId}`;
  const mk = `${rawDir()}|${key}`;
  if (!memo.has(mk)) memo.set(mk, JSON.parse(read(`${key}.json`)));
  return memo.get(mk) as Record<string, string>[];
}

export function loadIem(windowId: string): Record<string, string>[] {
  const key = `iem-rain__${windowId}`;
  const mk = `${rawDir()}|${key}`;
  if (!memo.has(mk)) memo.set(mk, parseCsv(read(`${key}.csv`)));
  return memo.get(mk) as Record<string, string>[];
}

export function loadLinks(): Record<string, string>[] {
  return JSON.parse(read("dot-links.json"));
}
