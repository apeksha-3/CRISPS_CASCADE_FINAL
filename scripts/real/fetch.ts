// scripts/real/fetch.ts
// Phase 7 step B. Fetch every raw dataset for every window, cache it, write the manifest.
//
//   Order matters (it is the point of the rules):
//     1. IEM daily rain totals           -> choose rain and dry CONTROL days   (real/select.ts)
//     2. 311 volume on the DRY days only -> choose the 10 zones               (docs/real-zones.md)
//     3. only now fetch the cascade windows and everything else
//
// Run: npx tsx scripts/real/fetch.ts      (a second run is offline: every request is cached)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../../real/csv";
import { assignGateways, buildNeighbours, isRealBoard, type RealZone, zoneIdOfBoard } from "../../real/geo";
import { type ManifestEntry, saveRaw, writeManifest } from "../../real/manifest";
import { cachedGet } from "../../real/net";
import { CASCADE_WINDOWS, EMS_LOOKBACK_S, LINK_MAX_KM, RANGE, ZONE_COUNT } from "../../real/params";
import { type Daily, MIN_DOT_ROWS, parseDaily, pickDry, pickRain, rainCandidates } from "../../real/select";
import { fetchAggregate, fetchRows } from "../../real/soda";
import { addDays, localIsoToUtcMs, utcMsToIemZ, utcMsToLocalIso } from "../../real/tz";

const entries: ManifestEntry[] = [];
const counts: Record<string, Record<string, number>> = {}; // dataset -> window -> rows

function note(e: ManifestEntry) {
  entries.push(e);
  (counts[e.dataset] ??= {})[e.window] = e.rows;
}

async function text(prefix: string, url: string): Promise<string> {
  const r = await cachedGet(prefix, url);
  if (r.status !== 200) throw new Error(`${prefix}: ${r.status === 0 ? r.body : `HTTP ${r.status}`} (${url})`);
  return r.body;
}

// ---------- 1. control days ----------
async function chooseControls(): Promise<{ rain: string[]; dry: string[]; ffwNotes: Record<string, string> }> {
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/daily.py?network=NY_ASOS&stations=NYC&stations=JFK&stations=LGA&sts=${RANGE.from}&ets=${addDays(RANGE.to, 1)}&format=csv`;
  const csv = await text("iem-daily", url);
  const rows = parseCsv(csv);
  note(saveRaw("iem-daily-2022-2023.csv", csv, { dataset: "iem-daily", window: "selection", query: url, rows: rows.length }));
  const daily: Daily = parseDaily(rows);

  // Which days does the DOT speeds dataset really cover? One aggregate query for the whole range.
  const dotDays: Record<string, string>[] = [];
  for (let m = 0; m < 24; m++) {
    const first = `${2022 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
    const next = `${2022 + Math.floor((m + 1) / 12)}-${String(((m + 1) % 12) + 1).padStart(2, "0")}-01`;
    dotDays.push(...(await fetchAggregate(`dot-daily-counts-${first}`, "i4gi-tjb9", {
      $select: "date_trunc_ymd(data_as_of) as day, count(*) as n",
      $where: `data_as_of >= '${first}T00:00:00' AND data_as_of < '${next}T00:00:00'`,
      $group: "day",
      $order: "day",
    })));
  }
  note(saveRaw("dot-daily-counts.json", JSON.stringify(dotDays), { dataset: "dot-daily-counts", window: "selection", query: "i4gi-tjb9 select=date_trunc_ymd(data_as_of),count(*) group=day, one query per month 2022-01..2023-12", rows: dotDays.length }));
  const dotRows = new Map(dotDays.map((r) => [r.day.slice(0, 10), Number(r.n)]));
  const hasTraffic = (day: string) => (dotRows.get(day) ?? 0) >= MIN_DOT_ROWS;

  // NWS flash flood emergencies for New York City, from the IEM archive of NWS text products.
  const ffwNotes: Record<string, string> = {};
  const hasEmergency = async (day: string): Promise<boolean> => {
    const sts = utcMsToIemZ(localIsoToUtcMs(`${day}T00:00:00`));
    const ets = utcMsToIemZ(localIsoToUtcMs(`${addDays(day, 1)}T00:00:00`));
    const u = `https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=FFWOKX&limit=500&sdate=${sts}&edate=${ets}&fmt=text`;
    const body = await text("nws-ffw", u);
    note(saveRaw(`nws-ffw-${day}.txt`, body, { dataset: "nws-ffw", window: day, query: u, rows: (body.match(/WGUS51 KOKX/g) ?? []).length }));
    const emergency = /FLASH FLOOD EMERGENCY FOR[^\n]*(NEW YORK CITY|NYC|BROOKLYN|QUEENS|BRONX|MANHATTAN)/i.test(body);
    ffwNotes[day] = `${(body.match(/WGUS51 KOKX/g) ?? []).length} OKX flash flood warning products${emergency ? ", flash flood EMERGENCY for NYC" : ""}`;
    return emergency;
  };
  const cands = rainCandidates(daily, hasTraffic);
  const rejected = new Set<string>();
  for (const c of cands.slice(0, 40)) if (await hasEmergency(c.day)) rejected.add(c.day);
  const rain = pickRain(cands, (d) => rejected.has(d));
  const dry = pickDry(daily, rain, hasTraffic);
  return { rain, dry, ffwNotes };
}

// ---------- 2. zones ----------
const dayWhere = (field: string, days: string[]) => days.map((d) => `(${field} >= '${d}T00:00:00' AND ${field} < '${addDays(d, 1)}T00:00:00')`).join(" OR ");

async function chooseZones(dry: string[]): Promise<RealZone[]> {
  const where = dayWhere("created_date", dry);
  const vol = await fetchAggregate("agg311-volume", "erm2-nwe9", { $select: "community_board, count(*) as n", $where: where, $group: "community_board", $order: "n DESC" });
  note(saveRaw("agg-311-volume-dry.json", JSON.stringify(vol), { dataset: "311-aggregate", window: "dry-days", query: `erm2-nwe9 select=community_board,count(*) where=${where} group=community_board`, rows: vol.length }));
  const cen = await fetchAggregate("agg311-centroid", "erm2-nwe9", { $select: "community_board, avg(latitude) as lat, avg(longitude) as lon", $where: `(${where}) AND latitude IS NOT NULL`, $group: "community_board" });
  note(saveRaw("agg-311-centroid-dry.json", JSON.stringify(cen), { dataset: "311-aggregate", window: "dry-days", query: `erm2-nwe9 select=community_board,avg(latitude),avg(longitude) where=${where} AND latitude IS NOT NULL group=community_board`, rows: cen.length }));
  const centroid = new Map(cen.map((r) => [r.community_board, { lat: Number(r.lat), lon: Number(r.lon) }]));
  const top = vol.filter((r) => isRealBoard(r.community_board) && centroid.has(r.community_board)).slice(0, ZONE_COUNT);
  const base = top.map((r) => ({
    zone_id: zoneIdOfBoard(r.community_board)!,
    name: r.community_board,
    lat: centroid.get(r.community_board)!.lat,
    lon: centroid.get(r.community_board)!.lon,
    volume: Number(r.n),
  }));
  const nb = buildNeighbours(base);
  const gw = assignGateways(base);
  return base.map((z) => ({ ...z, neighbours: nb[z.zone_id], gateway_id: gw[z.zone_id] }));
}

function zonesDoc(rain: string[], dry: string[], zones: RealZone[], ffw: Record<string, string>): string {
  const L = [
    "# Real zones and control days (Phase 7)",
    "",
    "Written by `scripts/real/fetch.ts`. The rules below were fixed in `real/params.ts` and `real/select.ts` and applied",
    "BEFORE the cascade windows were fetched: the fetch script picks controls, then zones, and only then downloads Ida and 2023.",
    "(Honest note: step A, the schema discovery, had already counted rows in the Ida week and listed 311 complaint types for one Ida night. That looked at volumes, not at any zone choice, and no zone rule uses it.)",
    "",
    "## Zone rule",
    "",
    `The ${ZONE_COUNT} NYC community districts with the highest TOTAL 311 request volume (all complaint types) summed over the ${dry.length} dry control days.`,
    "Only real community boards count (`NN BOROUGH`; 'Unspecified' is excluded). A zone's centroid is the mean 311 latitude/longitude of its requests on those days.",
    "Neighbours are the 3 nearest other centroids (straight-line km), made symmetric. Gateways are SYNTHETIC: zones sorted north to south are cut into 6 consecutive groups.",
    "",
    "| zone | community board | 311 requests on dry days | centroid lat | centroid lon | neighbours | synthetic gateway |",
    "|---|---|---|---|---|---|---|",
    ...zones.map((z) => `| ${z.zone_id} | ${z.name} | ${z.volume} | ${z.lat.toFixed(4)} | ${z.lon.toFixed(4)} | ${z.neighbours.join(", ")} | ${z.gateway_id} |`),
    "",
    "## Traffic links and collisions have no community board",
    "",
    "A DOT link is assigned to the nearest zone centroid using the first point of its `link_points`; a crash uses its latitude/longitude.",
    `Anything more than ${LINK_MAX_KM} km from every centroid is left out and counted in real/unmapped.json. This is an APPROXIMATION: a link belongs to the district whose 311 centre of gravity is nearest, not to the district whose boundary contains it.`,
    "",
    "## Control days",
    "",
    `Dry (${dry.length}, spread over 2022; Tue-Thu, zero rain at KNYC/KJFK/KLGA that day and the day before, no holiday, DOT data present): ${dry.join(", ")}`,
    "",
    `Rain (${rain.length}; weekday, KNYC 1.0-2.5 in, no NWS flash flood emergency for NYC, DOT data present):`,
    "",
    ...rain.map((d) => `- ${d}: ${ffw[d] ?? "n/a"}`),
    "",
  ];
  return L.join("\n");
}

// ---------- 3. datasets per window ----------
interface Win {
  id: string;
  kind: "cascade" | "rain" | "dry";
  from: string; // local date
  to: string; // local date, exclusive
}

const COMPLAINTS = ["Sewer", "Catch Basin", "Street Flooding", "Flooded Basement", "Water System", "Electric", "ELECTRIC"];

async function fetchWindow(w: Win): Promise<void> {
  const from = `${w.from}T00:00:00`;
  const to = `${w.to}T00:00:00`;
  const save = (dataset: string, ext: string, content: string, query: string, rows: number) =>
    note(saveRaw(`${dataset}__${w.id}.${ext}`, content, { dataset, window: w.id, query, rows }));
  const soda = async (dataset: string, id: string, select: string, where: string, order: string) => {
    const r = await fetchRows(`${dataset}-${w.id}`, id, { select, where, order });
    save(dataset, "json", JSON.stringify(r.rows), r.queryText, r.rows.length);
  };

  await soda("311", "erm2-nwe9", "unique_key,created_date,complaint_type,descriptor,community_board,borough,latitude,longitude",
    `created_date >= '${from}' AND created_date < '${to}' AND complaint_type in (${COMPLAINTS.map((c) => `'${c}'`).join(",")})`, "created_date,unique_key");
  await soda("dot-speeds", "i4gi-tjb9", "id,speed,travel_time,status,data_as_of,link_id",
    `data_as_of >= '${from}' AND data_as_of < '${to}'`, "data_as_of,id");
  await soda("collisions", "h9gi-nx95", "collision_id,crash_date,crash_time,borough,latitude,longitude,number_of_persons_injured,number_of_persons_killed",
    `crash_date >= '${from}' AND crash_date < '${to}'`, "crash_date,collision_id");
  const emsFrom = utcMsToLocalIso(localIsoToUtcMs(from) - EMS_LOOKBACK_S * 1000);
  await soda("ems", "76xm-jjuj", "incident_id,incident_datetime,initial_severity_level_code,first_hosp_arrival_datetime,communitydistrict,borough",
    `incident_datetime >= '${emsFrom}' AND incident_datetime < '${to}'`, "incident_datetime,incident_id");

  const sts = utcMsToIemZ(localIsoToUtcMs(from));
  const ets = utcMsToIemZ(localIsoToUtcMs(to));
  const iemUrl = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py?station=NYC&station=JFK&station=LGA&vars=precip&sts=${encodeURIComponent(sts)}&ets=${encodeURIComponent(ets)}&sample=1min&what=download&delim=comma&tz=UTC`;
  const iem = await text(`iem1min-${w.id}`, iemUrl);
  save("iem-rain", "csv", iem, iemUrl, parseCsv(iem).length);

  // NOAA ISD hourly: cross-check only, for the cascade windows
  if (w.kind === "cascade") {
    const isdUrl = `https://www.ncei.noaa.gov/access/services/data/v1?dataset=global-hourly&stations=72505394728,74486094789,72503014732&startDate=${w.from}&endDate=${addDays(w.to, -1)}&format=json&includeAttributes=false`;
    const isd = await text(`isd-${w.id}`, isdUrl);
    save("isd-hourly", "json", isd, isdUrl, (JSON.parse(isd) as unknown[]).length);
  }
}

async function fetchLinks(): Promise<void> {
  // The DOT link table (where each link is): one query for the whole Ida day, grouped by link.
  const rows = await fetchAggregate("dot-links", "i4gi-tjb9", {
    $select: "link_id, link_points, borough, link_name",
    $where: "data_as_of >= '2021-09-01T12:00:00' AND data_as_of < '2021-09-01T12:30:00'",
    $group: "link_id, link_points, borough, link_name",
    $order: "link_id",
  });
  note(saveRaw("dot-links.json", JSON.stringify(rows), { dataset: "dot-links", window: "static", query: "i4gi-tjb9 select=link_id,link_points,borough,link_name group=all four, 2021-09-01 12:00-12:30", rows: rows.length }));
}

async function main() {
  const { rain, dry, ffwNotes } = await chooseControls();
  console.log(`rain controls (${rain.length}): ${rain.join(" ")}`);
  console.log(`dry controls (${dry.length}): ${dry.join(" ")}`);
  const zones = await chooseZones(dry);
  console.log(`zones: ${zones.map((z) => `${z.zone_id}(${z.volume})`).join(" ")}`);
  writeFileSync(join("real", "controls.json"), JSON.stringify({ rain, dry, ffw: ffwNotes, zones }, null, 1) + "\n");
  writeFileSync(join("docs", "real-zones.md"), zonesDoc(rain, dry, zones, ffwNotes));

  await fetchLinks();
  const wins: Win[] = [
    ...CASCADE_WINDOWS.map((w) => ({ id: w.id, kind: "cascade" as const, from: w.from, to: w.to })),
    ...rain.map((d) => ({ id: `rain-${d}`, kind: "rain" as const, from: d, to: addDays(d, 1) })),
    ...dry.map((d) => ({ id: `dry-${d}`, kind: "dry" as const, from: d, to: addDays(d, 1) })),
  ];
  for (const w of wins) {
    await fetchWindow(w);
    console.log(`fetched ${w.id}`);
  }
  writeManifest(entries);

  const datasets = ["311", "dot-speeds", "collisions", "ems", "iem-rain", "isd-hourly"];
  console.log("\nrows per dataset per window");
  console.log(["window".padEnd(18), ...datasets.map((d) => d.padStart(11))].join(" "));
  for (const w of wins) console.log([w.id.padEnd(18), ...datasets.map((d) => String(counts[d]?.[w.id] ?? "-").padStart(11))].join(" "));
  console.log(`\nwrote data/real/MANIFEST.md (${entries.length} files) and real/controls.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
