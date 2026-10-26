// real/params.ts
// Every number the real-data adapters use, in one place. All of them were set
// BEFORE looking at engine results on real data and are never tuned on it.
// The delivery-delay values are COPIED from sim/params.ts (the simulator's delay
// model): this folder must not import sim/.

import type { SourceType } from "../engine/types";

export const EPISODE_S = 45 * 60; // every real episode is 45 minutes, like the simulator's

// ---- Delivery delay (copied from sim/params.ts) ----
// Real timestamps say when something happened, not when OUR engine heard about it.
// We add the simulator's delay model on top: lognormal around the source's nominal
// latency, clamped to 5..90 s, 4% of the time 1-2 minutes extra late.
// This is SYNTHETIC transport noise on top of REAL events.
export const NOMINAL_LATENCY_S: Record<SourceType, number> = {
  rain_gauge: 15,
  drainage_sensor: 20,
  traffic_sensor: 15,
  camera: 25,
  utility: 20,
  dispatch: 30,
  hospital: 60,
  citizen_report: 60,
  gateway: 20,
};
export const DELAY = { min_s: 5, max_s: 90, spread: 0.6, late_prob: 0.04, late_extra_s: [60, 120] as [number, number] };

// How often each kind of source normally says "I am alive" (public registry value).
// Sensors that report on a fixed cycle (traffic links every ~5 min, the rain gauge)
// send a heartbeat with every report. Event logs (311, EMS, collisions) have no cycle:
// they get a long interval and NO invented heartbeats.
export const HEARTBEAT_S = { traffic_sensor: 300, rain_gauge: 300, event_log: 3600 };

// ---- Zones ----
export const ZONE_COUNT = 10;
export const GATEWAY_COUNT = 6;
export const LINK_MAX_KM = 6; // a traffic link or crash farther than this from every zone centroid is left out
export const MIN_BASELINE_SAMPLES = 8; // fewer dry-day samples than this for a link-hour: no baseline, link not scored

// ---- Traffic (DOT speeds) ----
export const SLOWDOWN_FRACTION = 0.6; // slowdown when speed < 60% of the link's own baseline for that hour
export const DOT_OK_STATUS = "0"; // status -101 = the sensor reported no valid reading (treated as silence)

// ---- Rain (IEM 1-minute) ----
export const RAIN_BUCKET_S = 300; // one report per gauge per 5 minutes
export const RAIN_HEAVY_MM_H = 7.6; // NWS "heavy rain" starts at 0.30 in/h
export const RAIN_SEVERITY_FULL_MM_H = 50; // severity = mm/h / 50, clipped to 1 (50 mm/h = 2 in/h: rare, flooding-grade)
export const INCH_MM = 25.4;

// ---- EMS ----
// Per zone, a sliding window counts incidents. Spike when the count is clearly above
// what that zone/hour sees on dry control days: n >= MIN_COUNT and n > mean + Z * sqrt(mean).
export const EMS_CALLS = { window_s: 600, step_s: 300, min_count: 4, z: 3 };
export const EMS_HOSPITAL = { window_s: 1800, step_s: 300, min_count: 3, z: 3 };
export const EMS_LOOKBACK_S = 4 * 3600; // hospital arrival comes up to hours after the call: fetch calls that far back
// initial_severity_level_code is 1 (most severe) to 8 (least): severity = (9 - code) / 8.
export const emsSeverity = (code: number) => Math.min(1, Math.max(0, (9 - code) / 8));

// ---- Collisions ----
// Severity is a documented assumption, not data: no injury 0.3, injury 0.6, death 0.9.
export const COLLISION_SEVERITY = { none: 0.3, injured: 0.6, killed: 0.9 };

// ---- Control-day selection ----
export const RANGE = { from: "2022-01-01", to: "2023-12-31" }; // where control days are drawn from
export const RAIN_CONTROL = { count: 8, min_in: 1.0, max_in: 2.5 }; // KNYC daily total, inches
export const DRY_CONTROL = { count: 10, first_target: "2022-01-12", step_days: 36, search_days: 30 };
export const CANDIDATE_BUFFER_DAYS = 3; // controls stay this far away from the cascade windows
export const DRY_EPISODE_START_HOURS = [8, 19]; // local hours at which dry-day episodes start
export const RAIN_LEAD_IN_S = 15 * 60; // rain-day episodes start 15 min before the heaviest 30 minutes
export const OFFSETS_MIN = [10, 20, 30]; // cascade episodes: onset this many minutes into the episode

// US holidays on the Tue-Thu control days would change traffic; skip these dates.
export const HOLIDAYS = ["2022-01-17", "2022-02-21", "2022-05-30", "2022-06-20", "2022-07-04", "2022-09-05", "2022-10-10", "2022-11-11", "2022-11-24", "2022-12-25", "2022-12-26", "2023-01-02", "2023-01-16", "2023-02-20", "2023-05-29", "2023-06-19", "2023-07-04", "2023-09-04", "2023-10-09", "2023-11-23", "2023-12-25"];

// The two cascade candidate windows (local dates, end exclusive).
export const CASCADE_WINDOWS = [
  { id: "ida-2021", from: "2021-08-31", to: "2021-09-04" },
  { id: "flood-2023", from: "2023-09-27", to: "2023-10-01" },
];
