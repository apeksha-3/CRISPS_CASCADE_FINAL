// server/episodes.ts
// Load episodes from data/episodes/<split>/ (built by `npm run sim -- --build`).
// Files are read on demand and kept in memory.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, type Split } from "../sim/dataset";
import type { Episode } from "../sim/truth";

export const SPLITS: Split[] = ["dev", "test", "prior-shift"];
const cache = new Map<string, Episode>();

export function isSplit(s: unknown): s is Split {
  return typeof s === "string" && (SPLITS as string[]).includes(s);
}

export function episodeIds(split: Split): string[] {
  const dir = join(DATA_DIR, split);
  if (!existsSync(dir)) throw new Error(`no episodes in ${dir}. Run: npm run sim -- --build`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadEpisode(split: Split, id: string): Episode {
  if (!/^[\w-]+$/.test(id)) throw new Error(`bad episode id ${id}`); // no paths
  const key = `${split}/${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = join(DATA_DIR, split, `${id}.json`);
  if (!existsSync(file)) throw new Error(`episode ${id} not found in ${split}. Run: npm run sim -- --build`);
  const ep = JSON.parse(readFileSync(file, "utf8")) as Episode;
  cache.set(key, ep);
  return ep;
}

// A twin pair id like "test-twin-5221" -> [twin A, twin B] (left, right).
// Which one turns into a cascade is revealed only at episode-end.
export function loadTwinPair(split: Split, pairId: string): [Episode, Episode] {
  const [a, b] = ["A", "B"].map((s) => loadEpisode(split, `${pairId}-${s}`));
  for (const ep of [a, b]) if (ep.truth.twin_pair_id !== pairId) throw new Error(`${ep.episode_id} is not part of twin pair ${pairId}`);
  return [a, b];
}
