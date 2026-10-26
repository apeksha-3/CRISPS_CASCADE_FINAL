// scripts/real/fetch9.ts
// Phase 9 data for the nowcast, 2019-01-01 to END_DAY (a fixed date, so the data set never changes under a re-run):
//   IEM 1-minute rain (KNYC, KJFK, KLGA), one request per month
//   311 flood, drainage and water reports, citywide, one request per year (2019 comes from the archive dataset 76ig-c548,
//        2020 on from erm2-nwe9: the portal split the 311 history there). Both category schemes are fetched.
//   DOT traffic speeds as HOURLY per-link means (the portal aggregates; 113 million raw rows are not fetchable),
//        one request set per month, valid readings only (status 0).
// Everything is cached (real/net.ts) and listed in data/real/MANIFEST-phase9.md.
// Run: npx tsx scripts/real/fetch9.ts [rain|311|dot]   (default all; a second run is offline)

import { parseCsv } from "../../real/csv";
import { type ManifestEntry, saveRaw, writeManifest } from "../../real/manifest";
import { cachedGet } from "../../real/net";
import { fetchRows } from "../../real/soda";
import { addDays, localIsoToUtcMs, utcMsToIemZ } from "../../real/tz";
import { join } from "node:path";

export const START_DAY = "2019-01-01";
export const END_DAY = "2026-10-20"; // inclusive
const which = process.argv[2] ?? "all";
const entries: ManifestEntry[] = [];

function months(): { id: string; from: string; to: string }[] {
  const out: { id: string; from: string; to: string }[] = [];
  for (let y = 2019, m = 1; ; ) {
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    const nextFirst = `${ny}-${String(nm).padStart(2, "0")}-01`;
    if (from > END_DAY) break;
    const to = nextFirst > addDays(END_DAY, 1) ? addDays(END_DAY, 1) : nextFirst;
    out.push({ id: from.slice(0, 7), from, to });
    y = ny;
    m = nm;
  }
  return out;
}

const COMPLAINTS = ["Sewer", "Catch Basin", "Street Flooding", "Flooded Basement", "Water System", "Sewer Maintenance", "Water Maintenance"];

async function main() {
  const ms = months();
  if (which === "all" || which === "rain") {
    for (const m of ms) {
      const sts = utcMsToIemZ(localIsoToUtcMs(`${m.from}T00:00:00`));
      const ets = utcMsToIemZ(localIsoToUtcMs(`${m.to}T00:00:00`));
      const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py?station=NYC&station=JFK&station=LGA&vars=precip&sts=${encodeURIComponent(sts)}&ets=${encodeURIComponent(ets)}&sample=1min&what=download&delim=comma&tz=UTC`;
      const r = await cachedGet(`iem9-${m.id}`, url, { timeoutMs: 180_000 });
      if (r.status !== 200) throw new Error(`iem ${m.id}: ${r.status === 0 ? r.body : r.status}`);
      entries.push(saveRaw(`iem9__${m.id}.csv`, r.body, { dataset: "iem-rain-monthly", window: m.id, query: url, rows: parseCsv(r.body).length }));
    }
    console.log(`rain: ${ms.length} months`);
  }
  if (which === "all" || which === "311") {
    for (let y = 2019; y <= 2026; y++) {
      const from = `${y}-01-01`;
      const to = y === 2026 ? addDays(END_DAY, 1) : `${y + 1}-01-01`;
      const ds = y === 2019 ? "76ig-c548" : "erm2-nwe9";
      const r = await fetchRows(`f311-${y}`, ds, { select: "unique_key,created_date,complaint_type,descriptor", where: `created_date >= '${from}T00:00:00' AND created_date < '${to}T00:00:00' AND complaint_type in (${COMPLAINTS.map((c) => `'${c}'`).join(",")})`, order: "created_date,unique_key" });
      entries.push(saveRaw(`f311__${y}.json`, JSON.stringify(r.rows), { dataset: "311-flood-citywide", window: String(y), query: r.queryText, rows: r.rows.length }));
      console.log(`311 ${y}: ${r.rows.length}`);
    }
  }
  if (which === "all" || which === "dot") {
    for (const [mi, m] of ms.entries()) {
      if (process.env.SHARD && mi % Number(process.env.SHARDS ?? 1) !== Number(process.env.SHARD)) continue; // run several shards in parallel, then once more to write the manifest
      const r = await fetchRows(`dot9-${m.id}`, "i4gi-tjb9", {
        select: "link_id, date_trunc_ymd(data_as_of) as d, date_extract_hh(data_as_of) as h, avg(speed::number) as sp, count(*) as n",
        where: `status = '0' AND data_as_of >= '${m.from}T00:00:00' AND data_as_of < '${m.to}T00:00:00'`,
        group: "link_id, d, h",
        order: "d, h, link_id",
      });
      entries.push(saveRaw(`dot9__${m.id}.json`, JSON.stringify(r.rows), { dataset: "dot-hourly-means", window: m.id, query: r.queryText, rows: r.rows.length }));
      console.log(`dot ${m.id}: ${r.rows.length}`);
    }
  }
  writeManifest(entries, join(process.cwd(), "data", "real", `MANIFEST-phase9${which === "all" ? "" : "-" + which}.md`), `Real data manifest (Phase 9, ${which})`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
