// scripts/real/discover.ts
// Phase 7 step A: find out what the real NYC datasets actually look like.
// For each dataset we fetch 5 rows and read the REAL column names and types
// from the portal (Socrata sends them in the X-SODA2-Fields / X-SODA2-Types
// headers), count the rows in the Ida week, and write docs/real-data-schema.md.
// Nothing here assumes a field name: the date field is picked from the
// columns the portal reports, and the choice is printed.
//
// Run: npx tsx scripts/real/discover.ts
// Tokens (optional) are read from .env and never printed.

import { writeFileSync } from "node:fs";
import { cachedGet, readEnv, soqlUrl, socrataHeaders, type CachedResponse } from "../../real/net";
import { inferTimestampColumns, pickDateField } from "../../real/infer";

const env = readEnv();
const SOCRATA = socrataHeaders(env);

// The Ida week: Monday 30 Aug to Sunday 5 Sep 2021, local NYC time
// (Socrata floating timestamps are local time with no zone). In UTC that is
// 04:00 on 30 Aug to 04:00 on 6 Sep (EDT = UTC-4).
const IDA_FROM = "2021-08-30T00:00:00";
const IDA_TO = "2021-09-06T00:00:00";
const IDA_FROM_UTC = "2021-08-30T04:00Z";
const IDA_TO_UTC = "2021-09-06T04:00Z";

interface Finding {
  name: string;
  id: string;
  usable: boolean;
  reason?: string;
  columns: { name: string; type: string }[];
  dateField?: string;
  locationFields: string[];
  idaRows?: number;
  resolution?: string;
  note?: string;
}

// Every request goes through here so the exact URL and status are printed.
// Tokens are in headers, never in the URL, so printing the URL is safe.
const tried: { url: string; status: string }[] = [];
async function get(prefix: string, url: string, headers: Record<string, string> = {}): Promise<CachedResponse> {
  const r = await cachedGet(prefix, url, { headers });
  const status = r.status === 0 ? r.body : `HTTP ${r.status}${r.fromCache ? " (cache)" : ""}`;
  tried.push({ url, status });
  console.log(`  GET ${url}\n      -> ${status}`);
  return r;
}

function failReason(r: CachedResponse): string {
  return r.status === 0 ? r.body : `HTTP ${r.status}: ${r.body.slice(0, 160).replace(/\s+/g, " ")}`;
}

const SOCRATA_DATASETS = [
  { name: "311 Service Requests", id: "erm2-nwe9" },
  { name: "DOT Traffic Speeds NBE", id: "i4gi-tjb9" },
  { name: "Motor Vehicle Collisions - Crashes", id: "h9gi-nx95" },
  { name: "EMS Incident Dispatch", id: "76xm-jjuj" },
];

const LOCATION_HINT = /borough|boro|community|board|zip|latitude|longitude|location|link|geom|zone|district|precinct|cd$/i;

async function discoverSocrata(name: string, id: string): Promise<Finding> {
  const f: Finding = { name, id, usable: false, columns: [], locationFields: [] };
  const sample = await get(`discover-${id}`, soqlUrl(id, { $limit: "5" }), SOCRATA);
  if (sample.status !== 200) {
    f.reason = failReason(sample);
    return f;
  }
  const rows = JSON.parse(sample.body) as Record<string, unknown>[];
  const names: string[] = JSON.parse(sample.headers["x-soda2-fields"] ?? "[]");
  const types: string[] = JSON.parse(sample.headers["x-soda2-types"] ?? "[]");
  let timestamps: string[];
  if (names.length > 0) {
    f.columns = names.map((n, i) => ({ name: n, type: types[i] ?? "?" }));
    timestamps = f.columns.filter((c) => c.type === "floating_timestamp" || c.type === "calendar_date").map((c) => c.name);
  } else {
    // No type headers: take the keys of the sample rows, and call a column a
    // timestamp when its sample values look like ISO dates.
    timestamps = inferTimestampColumns(rows);
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
    f.columns = keys.map((k) => ({ name: k, type: timestamps.includes(k) ? "timestamp (inferred from values)" : "unknown (no type header)" }));
  }
  f.dateField = pickDateField(timestamps);
  f.locationFields = f.columns.map((c) => c.name).filter((n) => LOCATION_HINT.test(n));
  if (!f.dateField) {
    f.reason = "no timestamp column reported or inferred";
    return f;
  }
  const count = await get(
    `discover-count-${id}`,
    soqlUrl(id, { $select: "count(*) AS n", $where: `${f.dateField} >= '${IDA_FROM}' AND ${f.dateField} < '${IDA_TO}'` }),
    SOCRATA,
  );
  if (count.status !== 200) {
    f.reason = `count query ${failReason(count)}`;
    return f;
  }
  f.idaRows = Number((JSON.parse(count.body) as { n: string }[])[0]?.n ?? 0);
  f.usable = f.idaRows > 0;
  if (!f.usable) f.reason = `0 rows between ${IDA_FROM} and ${IDA_TO} on ${f.dateField}`;
  return f;
}

// Syndromic / ED visits: the id 2nwr-zzis is unverified. Test it directly,
// then print EVERY catalog candidate for a human to choose (no auto-pick).
async function discoverSyndromic(): Promise<Finding> {
  const meta = await get("discover-meta-2nwr-zzis", "https://data.cityofnewyork.us/api/views/2nwr-zzis.json", SOCRATA);
  const title = meta.status === 200 ? (JSON.parse(meta.body) as { name?: string }).name ?? "?" : undefined;
  const f = await discoverSocrata("Syndromic / ED visits (2nwr-zzis as given)", "2nwr-zzis");
  const notes = [title ? `2nwr-zzis is titled "${title}".` : `2nwr-zzis metadata: ${failReason(meta)}`];
  if (title && !/emergency|syndromic|\bED\b|visit/i.test(title)) {
    f.usable = false;
    f.reason = `2nwr-zzis is not an ED / syndromic table ("${title}")`;
  }
  const hits: { id: string; name: string; updated?: string }[] = [];
  for (const q of ["syndromic", "emergency department visits"]) {
    const u = new URL("https://api.us.socrata.com/api/catalog/v1");
    u.search = new URLSearchParams({ domains: "data.cityofnewyork.us", q, limit: "20" }).toString();
    const res = await get(`discover-catalog-${q.replace(/\W+/g, "_")}`, u.toString(), SOCRATA);
    if (res.status !== 200) {
      notes.push(`catalog search "${q}": ${failReason(res)}`);
      continue;
    }
    for (const r of (JSON.parse(res.body) as { results: { resource: { id: string; name: string; updatedAt?: string } }[] }).results)
      if (!hits.some((h) => h.id === r.resource.id)) hits.push({ id: r.resource.id, name: r.resource.name, updated: r.resource.updatedAt });
  }
  notes.push(hits.length ? `Catalog candidates (pick one by hand): ${hits.map((h) => `${h.id} "${h.name}"${h.updated ? ` (updated ${h.updated.slice(0, 10)})` : ""}`).join("; ")}.` : "No catalog candidates returned.");
  f.note = notes.join(" | ");
  return f;
}

// Rain sources, best resolution first. Each probe prints the exact URL and status.
const STATIONS = [
  { name: "Central Park", icao: "KNYC", iem: "NYC", isd: "72505394728" },
  { name: "JFK", icao: "KJFK", iem: "JFK", isd: "74486094789" },
  { name: "LaGuardia", icao: "KLGA", iem: "LGA", isd: "72503014732" },
];

async function discoverRain(): Promise<Finding[]> {
  const out: Finding[] = [];

  // (a) NYS Mesonet on S3: list the bucket (S3 ListObjectsV2). NYS Mesonet's
  // published data access policy describes licensed access only, so this
  // probe just records whether a public bucket answers at the host given.
  const mes: Finding = { name: "NYS Mesonet (S3 open-data bucket)", id: "nysmesonet.s3.amazonaws.com", usable: false, columns: [], locationFields: [], resolution: "5 minute (if available)" };
  const mu = new URL("https://nysmesonet.s3.amazonaws.com/");
  mu.search = new URLSearchParams({ "list-type": "2", "max-keys": "20" }).toString();
  const mr = await get("discover-mesonet-s3", mu.toString());
  if (mr.status === 200 && /<ListBucketResult/.test(mr.body)) {
    const keys = [...mr.body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    mes.note = `First keys: ${keys.join(", ") || "(none)"}`;
    mes.reason = "bucket lists, but no NYC 2021 5-minute files identified yet; inspect keys";
  } else mes.reason = failReason(mr);
  out.push(mes);

  // (b) Iowa Environmental Mesonet, ASOS 1-minute archive (backend
  // /cgi-bin/request/asos1min.py, documented at ?help). IEM names US ASOS
  // stations without the leading K (KNYC -> NYC).
  const iem: Finding = { name: "IEM ASOS 1-minute (KNYC, KJFK, KLGA)", id: "mesonet.agron.iastate.edu asos1min.py", usable: false, columns: [], locationFields: ["station"], resolution: "1 minute" };
  const iu = new URL("https://mesonet.agron.iastate.edu/cgi-bin/request/asos1min.py");
  const ip = new URLSearchParams();
  for (const s of STATIONS) ip.append("station", s.iem);
  for (const [k, v] of [["vars", "precip"], ["sts", IDA_FROM_UTC], ["ets", IDA_TO_UTC], ["sample", "1min"], ["what", "download"], ["delim", "comma"], ["tz", "UTC"]]) ip.append(k, v);
  iu.search = ip.toString();
  const ir = await get("discover-iem-1min-ida", iu.toString());
  if (ir.status === 200) {
    const lines = ir.body.trim().split(/\r?\n/);
    const header = (lines[0] ?? "").split(",");
    iem.columns = header.map((h) => ({ name: h, type: "string (CSV)" }));
    iem.dateField = header.find((h) => /valid|utc|time/i.test(h));
    iem.idaRows = Math.max(0, lines.length - 1);
    iem.usable = iem.idaRows > 0 && header.some((h) => /precip/i.test(h));
    if (!iem.usable) iem.reason = iem.idaRows === 0 ? "0 rows" : "no precip column in header";
  } else iem.reason = failReason(ir);
  out.push(iem);

  // (c) Fallback: NCEI Integrated Surface Data ("global-hourly", NCEI Access
  // Data Service v1, no token). Precipitation is field AA1.
  const isd: Finding = { name: "NOAA ISD hourly (global-hourly)", id: STATIONS.map((s) => s.isd).join(", "), usable: false, columns: [], locationFields: ["STATION", "NAME", "LATITUDE", "LONGITUDE"], resolution: "hourly (plus special reports)" };
  const nu = new URL("https://www.ncei.noaa.gov/access/services/data/v1");
  nu.search = new URLSearchParams({
    dataset: "global-hourly", stations: STATIONS.map((s) => s.isd).join(","),
    startDate: "2021-08-30", endDate: "2021-09-05", format: "json", includeAttributes: "false",
  }).toString();
  const nr = await get("discover-isd-ida", nu.toString());
  if (nr.status === 200) {
    const rows = JSON.parse(nr.body) as Record<string, string>[];
    // Scan ALL rows: AA1 only appears on rows that report precipitation.
    const keys = [...new Set(rows.flatMap((x) => Object.keys(x)))].sort();
    isd.columns = keys.map((k) => ({ name: k, type: "string" }));
    isd.dateField = keys.includes("DATE") ? "DATE" : pickDateField(inferTimestampColumns(rows));
    isd.idaRows = rows.length;
    const withRain = rows.filter((x) => x.AA1 !== undefined && x.AA1 !== "").length;
    isd.note = `${withRain} of ${rows.length} rows carry AA1.`;
    isd.usable = withRain > 0;
    if (!isd.usable) isd.reason = rows.length ? "no row has AA1 (precipitation)" : "0 rows";
  } else isd.reason = failReason(nr);
  out.push(isd);
  return out;
}

function markdown(all: Finding[]): string {
  const lines = [
    "# Real data schema (Phase 7, step A)",
    "",
    "Generated by `npx tsx scripts/real/discover.ts`. Columns and types are what the portals",
    "returned; nothing is assumed. Ida week = 2021-08-30 to 2021-09-05 (local time).",
    "",
    "| Dataset | Confirmed id | Usable | Date field | Location fields | Ida-week rows | Resolution | Reason if unusable |",
    "|---|---|---|---|---|---|---|---|",
    ...all.map((f) => `| ${f.name} | ${f.usable ? f.id : f.id + " (not confirmed)"} | ${f.usable ? "yes" : "NO"} | ${f.dateField ?? "-"} | ${f.locationFields.join(", ") || "-"} | ${f.idaRows ?? "-"} | ${f.resolution ?? "-"} | ${f.reason ?? ""} |`),
    "",
  ];
  for (const f of all) {
    lines.push(`## ${f.name}`, "");
    if (f.note) lines.push(f.note, "");
    if (f.columns.length === 0) lines.push("No columns: the dataset was not reached.", "");
    else lines.push("| Column | Type |", "|---|---|", ...f.columns.map((c) => `| ${c.name} | ${c.type} |`), "");
  }
  lines.push("## Requests tried", "", "| URL | Result |", "|---|---|", ...tried.map((t) => `| \`${t.url}\` | ${t.status} |`), "");
  return lines.join("\n");
}

async function main() {
  const all: Finding[] = [];
  for (const d of SOCRATA_DATASETS) all.push(await discoverSocrata(d.name, d.id));
  all.push(await discoverSyndromic());
  all.push(...(await discoverRain()));

  for (const f of all) {
    console.log(`\n== ${f.name} (${f.id}) ${f.usable ? "OK" : "UNUSABLE: " + f.reason}`);
    if (f.note) console.log(`   ${f.note}`);
    for (const c of f.columns) console.log(`   ${c.name.padEnd(36)} ${c.type}`);
    if (f.dateField) console.log(`   date field: ${f.dateField}; Ida-week rows: ${f.idaRows ?? "-"}`);
  }
  writeFileSync("docs/real-data-schema.md", markdown(all));
  // Rain counts as one dataset: usable if any rain source works.
  const rainOk = all.filter((f) => /Mesonet|IEM|ISD/.test(f.name)).some((f) => f.usable);
  const unusable = all.filter((f) => !/Mesonet|IEM|ISD/.test(f.name) && !f.usable).length + (rainOk ? 0 : 1);
  console.log(`\nwrote docs/real-data-schema.md; unusable datasets: ${unusable}`);
  if (unusable > 1) {
    console.log("STOP: more than one dataset is unusable. Review docs/real-data-schema.md before step B.");
    process.exitCode = 2;
  }
}

main();
