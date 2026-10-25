// sim/params.ts
// Every knob of the simulator in one place, with plain-language comments.
// Units: time in SECONDS, rates in "events per source per MINUTE".
// All values are hand-set so that episodes land in the target size range
// (`npm run sim -- --stats` checks this). Tune here, not in the code.

import type { SourceType } from "../engine/types";

export const TICK_S = 60; // one engine tick = one simulated minute
export const DEFAULT_DURATION_S = 45 * 60; // a cascade episode lasts 45 minutes

// Seed ranges. Dev and test never overlap, so we never tune on test data.
export const SEEDS = {
  dev: 1000, // dev seeds are 1000, 1001, ...
  test: 5000, // test seeds are 5000, 5001, ...
  prior_shift: 8000, // the 100-episode base-rate-shift sequence
};

// Healthy episode size (non-heartbeat events). Outside this => warning.
export const EVENT_COUNT_WARN = { min: 100, max: 700 };

// ---------------- World ----------------
export const WORLD = {
  zones: 10,
  zone_names: [
    "Harbor", "Old Town", "Riverside", "Market", "Hillview",
    "Station", "Industrial", "University", "Airport Rd", "Lakeside",
  ],
  extra_neighbour_links: 3, // random "chords" added to the ring of zones
  gateways: 6,
  big_gateway_zones: 3, // gateway 0 relays 3 zones, so it carries 25+ sensors
  big_gateway_min_sensors: 25,
  // sensors per zone: [min, max]
  sensors_per_zone: {
    rain_gauge: [1, 1],
    drainage_sensor: [2, 3],
    traffic_sensor: [2, 2],
    camera: [1, 2],
    utility: [1, 2], // power-grid and comms nodes
  } as Record<string, [number, number]>,
  dispatch_lines: 4, // emergency-call / dispatch lines (city wide)
  hospitals: [3, 4] as [number, number],
  citizen_sources: 20, // anonymous citizen-report channels
};

// Hidden true reliability ranges by source type: chance a source reports a
// real happening, and (inverted) how often it raises false alarms.
export const RELIABILITY: Record<SourceType, [number, number]> = {
  rain_gauge: [0.85, 0.97],
  drainage_sensor: [0.7, 0.95],
  traffic_sensor: [0.75, 0.95],
  camera: [0.8, 0.97],
  utility: [0.8, 0.95],
  dispatch: [0.9, 0.99],
  hospital: [0.9, 0.99],
  citizen_report: [0.4, 0.8],
  gateway: [0.95, 0.99],
};

export const CLOCK_OFFSET_MAX_S = 120; // hidden clock skew is uniform in +/- 2 min

// ---------------- Timing / delivery noise ----------------
export const HEARTBEAT = { interval_s: 300, jitter_s: 20 }; // "I am alive" about every 5 min

// Typical delay from happening to arrival, by source type (public "nominal latency").
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

export const DELAY = {
  min_s: 5, // normal delays are clamped to 5..90 s
  max_s: 90,
  spread: 0.6, // log-normal spread around the nominal latency
  late_prob: 0.04, // occasionally 1-2 min extra late
  late_extra_s: [60, 120] as [number, number],
  backlog_spread_s: 90, // after a gateway returns, its buffered events arrive within this window
};

export const DUPLICATE_PROB = 0.04; // retransmission: same id, sent again
export const DUPLICATE_GAP_S: [number, number] = [5, 120];
export const RETRACTION_PROB = 0.03; // source later says "ignore event X"
export const RETRACTION_AFTER_S: [number, number] = [60, 300];
export const ORPHAN_RETRACTION_SHARE = 0.25; // of retractions: arrive BEFORE their target
export const ORPHAN_TARGET_EXTRA_DELAY_S: [number, number] = [240, 480];

// Gateway monitor: says "gateway_heartbeat_lost" after 2+ minutes of silence.
export const MONITOR = { silence_s: 120, extra_delay_s: [10, 40] as [number, number] };

// ---------------- Background (normal city life) ----------------
// False-positive anomaly rate per source per minute at reliability 1.0.
// Lower reliability raises it: rate * (0.5 + 3 * (1 - reliability)).
export const BACKGROUND_FP_PER_MIN: Record<SourceType, number> = {
  rain_gauge: 0.04,
  drainage_sensor: 0.035,
  traffic_sensor: 0.04,
  camera: 0.03,
  utility: 0.03,
  dispatch: 0.12,
  hospital: 0.03,
  citizen_report: 0.012,
  gateway: 0,
};
export const MONSOON_RAIN_FP_MULT = 3; // monsoon regime: rain gauges blip 3x as often

// ---------------- Real happenings ("stages") ----------------
// When a stage is active in a zone, each matching source emits anomalies at
// this rate (per minute), times its reliability. Rates ramp up over ramp_s.
export const STAGE_RATE_PER_MIN = {
  rain_heavy: 0.3,
  drainage_anomaly: 0.22,
  traffic_slowdown: 0.16,
  emergency_call_spike: 0.18, // per dispatch line, per affected zone
  hospital_arrivals_unusual: 0.32, // per affected hospital
  power_comms_load: 0.18,
  citizen_report: 0.16, // per participating citizen source
};
export const STAGE_RAMP_S = 120;

// Cascade chain: lag (mean, sd, seconds) from the previous stage in the same zone.
export const CASCADE_LAGS = {
  onset_s: [60, 240] as [number, number], // when rain starts
  twin_onset_s: [30, 120] as [number, number], // twins start early so the prefix is busy
  rain_neighbour_s: [0, 90] as [number, number], // neighbours get rain a bit later
  drainage: { mean: 180, sd: 60 },
  traffic: { mean: 120, sd: 45 },
  calls: { mean: 120, sd: 45 },
  hospital: { mean: 150, sd: 60 }, // after calls; the first hospital stage = critical time
  power: { mean: 270, sd: 80 }, // after calls
  spread: { mean: 180, sd: 60 }, // calls spreading to a new neighbour zone
};
export const CASCADE_BRANCH = {
  neighbour_drainage_prob: 0.7, // a rained-on neighbour also floods
  spread_prob: 0.5, // calls spread to one more (dry) neighbour zone
  max_rain_neighbours: 2, // rain hits the origin zone plus up to 2 neighbours
};
export const SURGE_RATE_MULT = 1.2; // genuine large surge: many real distinct events

// Rain-only lookalike: same early chain, then rain stops; no hospital/power.
export const RAIN_ONLY = {
  rain_minutes: [15, 25] as [number, number],
  fade_after_rain_minutes: [3, 6] as [number, number],
  calls_rate_mult: 0.6, // storm calls are fewer than cascade calls
};

// Twin pairs: split between minute 5 and 9, with at least 40 prefix events.
export const TWIN = { split_min_s: 300, split_max_s: 540, min_prefix_events: 40, max_attempts: 30 };

// Lookalikes must look like a cascade early: at least this many shared
// signal kinds in the first 8 minutes, else the builder retries.
export const LOOKALIKE_CHECK = { window_s: 8 * 60, min_shared_kinds: 3, max_attempts: 30 };

// Gateway failures.
export const GATEWAY_FAIL = {
  start_s: [180, 720] as [number, number],
  outage_minutes: [8, 20] as [number, number],
  backlog_prob: 0.3, // chance the gateway buffers and dumps everything when it returns
  lie_bursts: [4, 8] as [number, number], // identical fake readings, one burst per minute
};

// Rumor wave: many near-identical citizen reports, one narrative, no physics.
export const RUMOR = { reports: [25, 45] as [number, number], spread_minutes: [2, 5] as [number, number] };
export const DUPLICATE_STORM_REPORTS = 50;

// Drifting reliability: these sources slowly get worse during the episode.
export const DRIFT = { sources: [5, 10] as [number, number], end_reliability: 0.3 };

// Fuzz: malformed events for quarantine tests (off by default).
export const FUZZ_EVENTS = 6;

// Episode length ranges in minutes, per type (cascades always use the default).
export const DURATION_MIN: Record<string, [number, number]> = {
  noise: [38, 45],
  default: [40, 45],
};

// Dataset mix (per split). The listed buckets add up to ~300 episodes.
export const DATASET_MIX = {
  noise: 40,
  sensor_failure: 40, // half outage, half gateway-lie
  isolated_incident: 40,
  cascade: 40,
  lookalike: { rain_only: 12, storm_calls: 10, flu_cluster: 9, gateway_outage: 9 },
  twin_pairs: 30,
  cutout: 20,
  rumor_wave: 6, // 3 pure rumor + 3 rumor with a real incident at the same time
  duplicate_storm: 5,
  surge: 5,
  drifting: 6,
};

// Prior-shift sequence: 100 episodes; at episode 50 the mix becomes "monsoon".
export const PRIOR_SHIFT = {
  length: 100,
  shift_at: 50,
  normal: { noise: 0.45, sensor_failure: 0.15, isolated_incident: 0.2, cascade: 0.08, rain_only: 0.06, storm_calls: 0.03, flu_cluster: 0.03 },
  monsoon: { noise: 0.25, sensor_failure: 0.1, isolated_incident: 0.15, cascade: 0.25, rain_only: 0.15, storm_calls: 0.08, flu_cluster: 0.02 },
};
