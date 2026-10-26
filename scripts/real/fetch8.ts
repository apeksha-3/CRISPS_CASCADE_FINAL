// scripts/real/fetch8.ts
// Phase 8 step C3. Fetch the raw data for the Phase 8 events (real/labels-p8.json): the event's first local day and the next.
// Writes data/real/MANIFEST-phase8.md (NWS archive, rain ranking, coverage counts and event windows).
// Run: npx tsx scripts/real/fetch8.ts

import { readFileSync } from "node:fs";
import { fetchWindow } from "../../real/fetchwin";
import { type ManifestEntry, MANIFEST8_PATH, writeManifest } from "../../real/manifest";
import { addDays } from "../../real/tz";

const labels = JSON.parse(readFileSync("real/labels-p8.json", "utf8")) as { events: { event_id: string; window: string; first_nyc_warning_local: string }[] };
const entries: ManifestEntry[] = JSON.parse(readFileSync("data/real/manifest-nws.json", "utf8"));
const counts: Record<string, Record<string, number>> = {};
const note = (e: ManifestEntry) => {
  entries.push(e);
  (counts[e.dataset] ??= {})[e.window] = e.rows;
};
for (const e of labels.events) {
  const day = e.first_nyc_warning_local.slice(0, 10);
  await fetchWindow({ id: e.window, kind: "cascade", from: day, to: addDays(day, 2) }, note);
  console.log(`fetched ${e.window}`);
}
writeManifest(entries, MANIFEST8_PATH, "Real data manifest (Phase 8)");
const datasets = ["311", "dot-speeds", "collisions", "ems", "iem-rain", "isd-hourly"];
console.log("\nrows per dataset per window");
console.log(["window".padEnd(18), ...datasets.map((d) => d.padStart(11))].join(" "));
for (const e of labels.events) console.log([e.window.padEnd(18), ...datasets.map((d) => String(counts[d]?.[e.window] ?? "-").padStart(11))].join(" "));
console.log(`\nwrote ${MANIFEST8_PATH} (${entries.length} files)`);
