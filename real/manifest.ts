// real/manifest.ts
// Every raw file we keep is listed in data/real/MANIFEST.md with the query that made it,
// its row count and its SHA-256. The raw files themselves are gitignored; the manifest is
// committed, so anyone can re-fetch and check they got the same bytes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RAW_DIR } from "./net";

export interface ManifestEntry {
  file: string; // relative to data/real/raw
  dataset: string;
  window: string;
  query: string;
  rows: number;
  sha256: string;
}

export const MANIFEST_PATH = join(process.cwd(), "data", "real", "MANIFEST.md");

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Write (or reuse) one consolidated raw file and describe it.
export function saveRaw(file: string, content: string, meta: Omit<ManifestEntry, "file" | "sha256">): ManifestEntry {
  const path = join(RAW_DIR, file);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content);
  return { file, sha256: sha256(content), ...meta };
}

export function writeManifest(entries: ManifestEntry[]): void {
  const sorted = entries.slice().sort((a, b) => (a.file < b.file ? -1 : 1));
  const L = [
    "# Real data manifest (Phase 7)",
    "",
    "Written by `npx tsx scripts/real/fetch.ts`. The raw files live in `data/real/raw/` (gitignored).",
    "Re-fetching must reproduce these row counts and hashes for any file the portal has not revised.",
    "Socrata rows are JSON arrays in the portal's own order (date, then id); IEM and NWS files are the raw response text.",
    "Times: Socrata timestamps are NYC local wall clock; IEM valid(UTC) and NOAA DATE are UTC.",
    "",
    "| file | dataset | window | rows | SHA-256 | query |",
    "|---|---|---|---|---|---|",
    ...sorted.map((e) => `| ${e.file} | ${e.dataset} | ${e.window} | ${e.rows} | ${e.sha256} | \`${e.query.replace(/\|/g, "\\|")}\` |`),
    "",
  ];
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, L.join("\n"));
}
