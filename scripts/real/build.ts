// scripts/real/build.ts
// Phase 7 step C+D: run the adapters and cut the episodes.
//   writes data/episodes/real/*.json   (what `npm run eval -- --split real` loads; gitignored)
//          real/unmapped.json          (rows no adapter could map, counted by reason; committed)
//          data/real/episodes-index.json
// Reads only the cached raw files, so two runs give byte-identical episodes.
//
// Run: npx tsx scripts/real/build.ts

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadContext } from "../../real/context";
import { buildAll } from "../../real/episodes";
import { Unmapped } from "../../real/obs";

const ctx = loadContext();
const unmapped = new Unmapped();
// --registry all     every DOT link is a source (the Phase 7 behaviour)
// --registry healthy only links that report on normal days (Phase 8, the default)
// --out <split>      folder under data/episodes (default real; the Phase 7 replay is rebuilt as real-p7)
const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const registry = arg("registry", "healthy") as "all" | "healthy";
const out = arg("out", "real");
const phase8Events = arg("events", out === "real-p7" ? "p7" : "p8") === "p8"; // real-p7 = the Phase 7 episode set
const allBuilt = buildAll(ctx, unmapped, { registry, phase8Events });
const built = allBuilt.filter((b) => b.tier !== "ambiguous");
const ambiguous = allBuilt.filter((b) => b.tier === "ambiguous");

const dir = join(process.cwd(), "data", "episodes", out);
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) rmSync(join(dir, f));
for (const b of built) writeFileSync(join(dir, `${b.episode.episode_id}.json`), JSON.stringify(b.episode));

// ambiguous events (a flash flood warning, no cited cascade-class impact) are written to their own split and never scored
const adir = join(process.cwd(), "data", "episodes", `${out}-ambiguous`);
mkdirSync(adir, { recursive: true });
for (const f of readdirSync(adir)) rmSync(join(adir, f));
for (const b of ambiguous) writeFileSync(join(adir, `${b.episode.episode_id}.json`), JSON.stringify(b.episode));
const index = built.map((b) => ({ episode_id: b.episode.episode_id, hypothesis: b.episode.truth.hypothesis, group: b.episode.type, start_local: b.startLocal, events: b.episode.events.length, counts: b.counts }));
writeFileSync(join(process.cwd(), "data", "real", `episodes-index-${out}.json`), JSON.stringify(index, null, 1));
const sorted = Object.fromEntries(Object.entries(unmapped.counts).sort((a, b) => b[1] - a[1]));
writeFileSync(
  join(process.cwd(), "real", out === "real" ? "unmapped.json" : `unmapped-${out}.json`),
  JSON.stringify(
    {
      note: "Rows no adapter could map, counted by reason, summed over every episode built by scripts/real/build.ts (a row seen by several episodes is counted in each). Nothing is invented to fill a gap.",
      traffic_links: ctx.linkStats,
      reasons: sorted,
    },
    null,
    1,
  ) + "\n",
);

console.log(`${"episode".padEnd(34)} ${"truth".padEnd(18)} ${"start (local)".padEnd(20)} events  by kind`);
for (const r of index) console.log(`${r.episode_id.padEnd(34)} ${r.hypothesis.padEnd(18)} ${r.start_local.padEnd(20)} ${String(r.events).padStart(6)}  ${Object.entries(r.counts).sort().map(([k, v]) => `${k}:${v}`).join(" ")}`);
console.log(`\n${built.length} scored episodes, ${ambiguous.length} ambiguous episodes (data/episodes/${out}-ambiguous) ;`);
console.log(`${built.length} episodes -> data/episodes/${out}/ ; unmapped reasons -> real/unmapped.json`);
console.log(`traffic links: ${ctx.linkStats.mapped} in a zone, ${ctx.linkStats.outside} farther than the cutoff, ${ctx.linkStats.noCoords} without coordinates`);
