// real/fetchwin.ts
// Fetch every raw dataset for one window (a run of whole local days): 311, DOT speeds, collisions, EMS, IEM rain,
// and NOAA ISD hourly for cascade windows. Shared by scripts/real/fetch.ts (Phase 7) and fetch8.ts (Phase 8).

import { parseCsv } from "./csv";
import { type ManifestEntry, saveRaw } from "./manifest";
import { cachedGet } from "./net";
import { EMS_LOOKBACK_S } from "./params";
import { fetchRows } from "./soda";
import { addDays, localIsoToUtcMs, utcMsToIemZ, utcMsToLocalIso } from "./tz";

export interface Win {
  id: string;
  kind: "cascade" | "rain" | "dry";
  from: string; // local date
  to: string; // local date, exclusive
}

async function text(prefix: string, url: string): Promise<string> {
  const r = await cachedGet(prefix, url, { timeoutMs: 120_000 });
  if (r.status !== 200) throw new Error(`${prefix}: ${r.status === 0 ? r.body : `HTTP ${r.status}`} (${url})`);
  return r.body;
}

// NYC renamed its 311 sewer and water types in early 2026 (Sewer -> Sewer Maintenance, Water System -> Water Maintenance); both spellings are fetched.
const COMPLAINTS = ["Sewer", "Catch Basin", "Street Flooding", "Flooded Basement", "Water System", "Electric", "ELECTRIC", "Sewer Maintenance", "Water Maintenance"];

export async function fetchWindow(w: Win, note: (e: ManifestEntry) => void): Promise<void> {
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

