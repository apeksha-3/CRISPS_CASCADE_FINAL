// sim/dataset.ts
// Builds the dev and test sets (same recipe, different seeds) and the
// 100-episode prior-shift sequence. Also loads them back from data/episodes.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildOptions, generateEpisode, generateTwinPair, type ScenarioName } from "./episode";
import { DATASET_MIX, PRIOR_SHIFT, SEEDS } from "./params";
import { rngFor } from "./rng";
import type { Episode, LookalikeType } from "./truth";

export type Split = "dev" | "test" | "prior-shift";
export const DATA_DIR = join(process.cwd(), "data", "episodes");

// A short label used to group results: "cascade", "lookalike:rain_only", "twin:benign"...
export function groupOf(ep: Episode): string {
  const t = ep.truth;
  if (ep.type === "lookalike") return `lookalike:${t.lookalike}`;
  if (ep.type === "twin") return `twin:${t.twin_role}`;
  if (ep.type === "sensor_failure" || ep.type === "cutout" || ep.type === "rumor_wave") return `${ep.type}:${t.variant}`;
  return ep.type;
}

export function buildSplit(split: "dev" | "test"): Episode[] {
  let seed = SEEDS[split];
  const out: Episode[] = [];
  const add = (name: ScenarioName, opts: BuildOptions = {}) => {
    const s = seed++;
    out.push(generateEpisode(name, s, { ...opts, episode_id: `${split}-${name}-${s}` }));
  };
  const m = DATASET_MIX;
  for (let i = 0; i < m.noise; i++) add("noise");
  for (let i = 0; i < m.sensor_failure; i++) add("sensor_failure", { variant: i % 2 === 0 ? "outage" : "lie" });
  for (let i = 0; i < m.isolated_incident; i++) add("isolated_incident");
  for (let i = 0; i < m.cascade; i++) add("cascade");
  for (const [look, n] of Object.entries(m.lookalike)) for (let i = 0; i < n; i++) add(look as LookalikeType);
  for (let i = 0; i < m.twin_pairs; i++) {
    const s = seed++;
    out.push(...generateTwinPair(s, { episode_id: `${split}-twin-${s}` }));
  }
  for (let i = 0; i < m.cutout; i++) add("cutout", { variant: i % 5 < 3 ? "cameras" : "gateway" });
  for (let i = 0; i < m.rumor_wave; i++) add("rumor_wave", { variant: i % 2 === 0 ? "pure" : "with_real" });
  for (let i = 0; i < m.duplicate_storm; i++) add("duplicate_storm");
  for (let i = 0; i < m.surge; i++) add("surge");
  for (let i = 0; i < m.drifting; i++) add("drifting", { base: i % 2 === 0 ? "noise" : "cascade" });
  return out;
}

// 100 episodes in order. From episode 51 on, the base-rate mix silently shifts
// to a monsoon regime: more rain-only days and more cascades.
// Phase 4: each half holds EXACTLY its regime's mix (counts = share x 50, rounded by
// largest remainder), in a seeded shuffled order. Phase 1 drew every episode
// independently, and that draw gave 9 cascades in the "normal" half (18%, nominal 8%)
// and 11 in the monsoon half (22%, nominal 25%): the sequence barely shifted at all.
export function regimeCounts(mix: Record<string, number>, n: number): [string, number][] {
  const raw = Object.entries(mix).map(([k, p]) => ({ k, x: p * n }));
  const out = raw.map(({ k, x }) => ({ k, c: Math.floor(x), r: x - Math.floor(x) }));
  let left = n - out.reduce((s, o) => s + o.c, 0);
  for (const o of out.slice().sort((a, b) => b.r - a.r)) {
    if (left <= 0) break;
    o.c++;
    left--;
  }
  return out.map((o) => [o.k, o.c]);
}

export function buildPriorShift(): Episode[] {
  const rng = rngFor(SEEDS.prior_shift, "mix");
  const half = (mix: Record<string, number>, n: number) => rng.shuffle(regimeCounts(mix, n).flatMap(([k, c]) => Array<string>(c).fill(k)));
  const names = [...half(PRIOR_SHIFT.normal, PRIOR_SHIFT.shift_at), ...half(PRIOR_SHIFT.monsoon, PRIOR_SHIFT.length - PRIOR_SHIFT.shift_at)];
  return names.map((name, i) => {
    const seed = SEEDS.prior_shift + i;
    return generateEpisode(name as ScenarioName, seed, {
      weather: i >= PRIOR_SHIFT.shift_at ? "monsoon" : "normal",
      episode_id: `shift-${String(i).padStart(3, "0")}-${name}`,
    });
  });
}

export function writeSplit(split: Split, eps: Episode[]): string {
  const dir = join(DATA_DIR, split);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const ep of eps) writeFileSync(join(dir, `${ep.episode_id}.json`), JSON.stringify(ep));
  return dir;
}

export function loadSplit(split: Split): Episode[] {
  const dir = join(DATA_DIR, split);
  if (!existsSync(dir)) throw new Error(`no episodes in ${dir}. Run: npm run sim -- --build`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Episode);
}
