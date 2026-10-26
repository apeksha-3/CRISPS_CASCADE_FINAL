// scripts/real/nowcast-replay-data.ts
// Phase 10: cut the three real events the dashboard replays out of the Phase 9 tick data (data/ml/ticks.csv, built from the
// cached raw data) and save them as ml/replay/events.json, a small committed file, so the dashboard's nowcast mode works without
// the 1 GB raw cache. Each tick keeps its 14 features, its local time, and what really happened in the next hour (hindsight, shown
// only in the technical view).
// Run: npx tsx scripts/real/nowcast-replay-data.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FEATURES } from "../../ml/dataset";

const EVENTS = [
  { id: "ida-2021", title: "Hurricane Ida remnants, 1 Sep 2021", match: "2021-09-01T21:28", note: "NWS flash flood emergency for New York City at 21:28; every subway line suspended at 22:45." },
  { id: "flood-2023", title: "Flash flood, 29 Sep 2023", match: "2023-09-29T08:30", note: "State of emergency declared; partial subway suspension; LaGuardia terminal closed." },
  { id: "flood-2025", title: "Flash flood, 14 Jul 2025", match: "2025-07-14T19:30", note: "Flash flood warnings for all five boroughs; several subway lines suspended that night." },
];
const lines = readFileSync("data/ml/ticks.csv", "utf8").trim().split("\n");
const head = lines[0].split(",");
const col = (n: string) => head.indexOf(n);
const rows = lines.slice(1).map((l) => l.split(","));
const out = EVENTS.map((e) => {
  const day = e.match.slice(0, 10);
  const ids = [...new Set(rows.filter((r) => r[col("local")].slice(0, 10) === day).map((r) => r[col("event")]))];
  const span = (id: string) => rows.filter((r) => r[col("event")] === id).map((r) => r[col("local")]);
  const id = ids.find((i) => Math.min(...span(i).map((x) => +x.replace(/\D/g, "").slice(0, 12))) <= +e.match.replace(/\D/g, "") && +e.match.replace(/\D/g, "") <= Math.max(...span(i).map((x) => +x.replace(/\D/g, "").slice(0, 12)))) ?? ids[0];
  const ticks = rows.filter((r) => r[col("event")] === id).map((r) => ({
    local: r[col("local")],
    f: FEATURES.map((n) => Number(r[col(n)])),
    y311: Number(r[col("y311")]),
    ytraffic: r[col("ytraffic")] === "" ? null : Number(r[col("ytraffic")]),
  }));
  return { id: e.id, title: e.title, note: e.note, tick_event: id, split: rows.find((r) => r[col("event")] === id)![col("split")], ticks };
});
mkdirSync("ml/replay", { recursive: true });
writeFileSync("ml/replay/events.json", JSON.stringify({ features: FEATURES, events: out }));
for (const e of out) console.log(`${e.id}: ${e.ticks.length} ticks, ${e.ticks[0].local} to ${e.ticks[e.ticks.length - 1].local}, tick event ${e.tick_event} (${e.split})`);
