// scripts/real/nowcast-data.ts
// Phase 9 steps B and C: build the tick data set from the cached raw files and write data/ml/ticks.csv (gitignored),
// data/ml/events.json and a printed summary (label definitions, dataset sizes, positive rates).
// Run: npx tsx scripts/real/nowcast-data.ts [--no-dot]

import { mkdirSync, writeFileSync } from "node:fs";
import { buildDataset, FEATURES, type Tick } from "../../ml/dataset";

const withDot = !process.argv.includes("--no-dot");
const built = buildDataset(withDot);
const ticks = built.ticks;
mkdirSync("data/ml", { recursive: true });

const num = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 1e6) / 1e6) : "");
const header = ["event", "split", "local", ...FEATURES, "y311", "thr311", "ytraffic", "thr_traffic"];
const lines = [header.join(",")];
for (const t of ticks) lines.push([t.event, t.split, t.local, ...t.f.map(num), t.y311, num(t.thr311), num(t.ytraffic), num(t.thrTraffic)].join(","));
writeFileSync("data/ml/ticks.csv", lines.join("\n") + "\n");

// events: first tick, last tick, size, split
const ev = new Map<string, { split: string; first: string; last: string; ticks: number; pos311: number; maxRate: number }>();
for (const t of ticks) {
  const e = ev.get(t.event) ?? { split: t.split, first: t.local, last: t.local, ticks: 0, pos311: 0, maxRate: 0 };
  e.last = t.local;
  e.ticks++;
  e.pos311 += t.y311;
  e.maxRate = Math.max(e.maxRate, t.f[0]);
  ev.set(t.event, e);
}
writeFileSync("data/ml/events.json", JSON.stringify([...ev.entries()].map(([id, e]) => ({ id, ...e })), null, 1));

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(`dry days found: ${built.dryDays}; ticks dropped: ${JSON.stringify(built.dropped)}`);
console.log("\nsplit      events  ticks   y311 positive   traffic ticks  traffic positive");
for (const s of ["train", "validate", "test"] as Tick["split"][]) {
  const ts = ticks.filter((t) => t.split === s);
  const tr = ts.filter((t) => Number.isFinite(t.ytraffic));
  const evs = new Set(ts.map((t) => t.event)).size;
  console.log(`${s.padEnd(10)} ${String(evs).padStart(6)} ${String(ts.length).padStart(6)}   ${pct(ts.reduce((a, t) => a + t.y311, 0) / Math.max(1, ts.length)).padStart(13)}   ${String(tr.length).padStart(13)}  ${pct(tr.reduce((a, t) => a + t.ytraffic, 0) / Math.max(1, tr.length)).padStart(15)}${evs < 30 ? "   <- fewer than 30 events: thin" : ""}`);
}
const all = ticks.filter((t) => Number.isFinite(t.ytraffic));
console.log(`all        ${String(ev.size).padStart(6)} ${String(ticks.length).padStart(6)}   ${pct(ticks.reduce((a, t) => a + t.y311, 0) / ticks.length).padStart(13)}   ${String(all.length).padStart(13)}  ${pct(all.reduce((a, t) => a + t.ytraffic, 0) / Math.max(1, all.length)).padStart(15)}`);
const th = ticks.map((t) => t.thr311).sort((a, b) => a - b);
console.log(`\n311 threshold (reports in the next 60 min): min ${th[0].toFixed(1)}, median ${th[Math.floor(th.length / 2)].toFixed(1)}, max ${th[th.length - 1].toFixed(1)}`);
if (withDot) {
  const tt = all.map((t) => t.thrTraffic).sort((a, b) => a - b);
  console.log(`traffic threshold (share of healthy links in slowdown): min ${tt[0].toFixed(2)}, median ${tt[Math.floor(tt.length / 2)].toFixed(2)}, max ${tt[tt.length - 1].toFixed(2)}`);
  console.log(`ticks with a DOT feature: ${pct(ticks.filter((t) => t.f[13] === 1).length / ticks.length)}`);
}
console.log(`\nwrote data/ml/ticks.csv (${ticks.length} ticks), data/ml/events.json (${ev.size} events)`);
