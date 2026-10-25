// config/likelihoods-handset.ts
// THE HAND-SET LIKELIHOOD TABLES (Phases 2-3), kept unchanged so the eval can
// compare them with the dev-tuned ones in config/likelihoods.ts (policy "engine-handset").
// This file also owns the table TYPES, the causal `upstream` rules and the
// severity gate: tuning only changes the numbers, never the structure.
//
// How much ONE event pushes the belief, per hypothesis, as a LOG-likelihood
// (natural log, "nats"). Only the DIFFERENCES within a row matter:
//   row { NOISE: 0, CASCADING_CRISIS: +0.7 } means "this event is e^0.7 = 2x
//   more typical of a cascade than of normal noise".
// 0 everywhere = the event tells us nothing.
//
// Each kind has two rows:
//   alone   - no upstream cause was seen earlier in the window
//   chained - its causal predecessor came first (e.g. traffic after drainage
//             in the same zone). Causal order is the cascade's fingerprint.
// Rain is the root of the chain, so it only has `alone`.
//
// Hand-set from the causal story (and a look at DEV event rates only).
// Columns: NOISE, SENSOR_FAILURE, ISOLATED, CASCADE.

import type { EventKind, Hypothesis } from "../engine/types";

export type LLRow = Record<Hypothesis, number>;
export const row = (noise: number, sensor: number, isolated: number, cascade: number): LLRow => ({
  NOISE: noise,
  SENSOR_FAILURE: sensor,
  ISOLATED_INCIDENT: isolated,
  CASCADING_CRISIS: cascade,
});

export interface Upstream {
  kinds: EventKind[]; // any of these, seen earlier, makes the event "chained"
  // zone     the predecessors must be in the event's own zone
  // city     anywhere in the city
  // one_zone anywhere, but `min` of them in ONE zone (a local wave, not scattered blips)
  scope: "zone" | "city" | "one_zone";
  min: number; // how many strong predecessor events are needed
}

export interface KindLikelihood {
  alone: LLRow;
  chained?: LLRow;
  upstream?: Upstream;
}

export const HANDSET_LIKELIHOODS: Partial<Record<EventKind, KindLikelihood>> = {
  // Heavy rain happens on normal stormy days AND in cascades. A broken
  // sensor rarely shows up as rain. Small tilt toward cascade.
  rain_heavy: { alone: row(0, -0.3, -0.3, 0.05) },

  // Drainage after rain = flooding starting (cascade-ish).
  // Drainage without rain = a local pipe problem (isolated) or a false positive.
  drainage_anomaly: {
    upstream: { kinds: ["rain_heavy"], scope: "zone", min: 1 },
    chained: row(0, -0.2, -0.2, 0.06),
    alone: row(0, 0, 0.2, -0.1),
  },

  // Traffic after drainage = flooded roads (cascade-ish). Alone = an accident.
  traffic_slowdown: {
    upstream: { kinds: ["drainage_anomaly"], scope: "zone", min: 1 },
    chained: row(0, -0.2, 0, 0.06),
    alone: row(0, 0, 0.15, -0.1),
  },

  // Emergency calls after traffic in the same zone: cascade likely.
  // Calls out of nowhere: a local incident, or normal storm-day calls.
  emergency_call_spike: {
    upstream: { kinds: ["traffic_slowdown"], scope: "zone", min: 1 },
    chained: row(0, -0.3, 0.1, 0.15),
    alone: row(0, -0.3, 0.2, -0.1),
  },

  // Hospitals filling up AFTER a wave of calls is the late-stage cascade signal.
  // Hospitals busy with no calls before = flu-like (NOISE). The hospital may be in
  // another zone than the calls (the nearest one), so the calls can be anywhere,
  // but since Phase 4 at least 2 of them must come from ONE zone (scope one_zone).
  // Two scattered everyday dispatch calls made flu-day hospital arrivals look like
  // the cascade's late stage (dev pool: 16-18% of flu-cluster days alerted).
  hospital_arrivals_unusual: {
    upstream: { kinds: ["emergency_call_spike"], scope: "one_zone", min: 2 },
    chained: row(-0.3, -0.8, 0.3, 0.8),
    alone: row(0.2, -0.5, 0, -0.5),
  },

  // Power / comms overload after calls in that zone: the cascade's last stage.
  // Power alarms with no calls at all look like a sensor (or gateway) problem.
  power_comms_load: {
    upstream: { kinds: ["emergency_call_spike"], scope: "zone", min: 1 },
    chained: row(-0.5, -0.5, -0.3, 0.8),
    alone: row(0, 0.5, -0.2, -0.2),
  },

  // Citizen reports: weak on their own. Trust tempering (engine/trust.ts) shrinks them more.
  citizen_report: { alone: row(0, -0.2, 0.1, 0.05) },

  // "Gateway stopped pinging": strong evidence of a sensor failure.
  gateway_heartbeat_lost: { alone: row(0, 2.0, -0.5, -0.5) },
};

// Events below this reported_severity are "everyday blips": normal city life
// produces them all the time. They get LOW_SEVERITY instead of their kind's row.
export const SEVERITY_GATE = { strong: 0.5 };
export const HANDSET_LOW_SEVERITY: LLRow = row(0.02, 0, 0, -0.01);

// ---- Phase 3: special rows for grouped evidence (engine/grouping.ts) ----

// Gateway perfect-correlation: 5+ sensors behind ONE gateway report the exact
// same value in the same minute. Real floods do not do that; a broken or lying
// gateway does. One such group = one strong "the gateway is lying" unit,
// and almost impossible under a real cascade.
export const HANDSET_GATEWAY_CORRELATED: LLRow = row(0, 2.0, -0.5, -1.5);

// Uncorroborated narrative cluster (a probable rumor): many citizens repeating
// one story with no physical sensor seeing anything in that zone. Counted as
// ONE weak unit: slightly "something local", almost nothing toward cascade.
export const HANDSET_RUMOR_CAPPED: LLRow = row(0, -0.1, 0.07, 0);

// Everything the filter needs to score a unit, in one object, so the eval can
// run the engine with either set of tables (tuned or hand-set).
export interface LikelihoodTables {
  kinds: Partial<Record<EventKind, KindLikelihood>>;
  low: LLRow; // LOW_SEVERITY
  gateway: LLRow; // GATEWAY_CORRELATED
  rumor: LLRow; // RUMOR_CAPPED
}

export const HANDSET_TABLES: LikelihoodTables = {
  kinds: HANDSET_LIKELIHOODS,
  low: HANDSET_LOW_SEVERITY,
  gateway: HANDSET_GATEWAY_CORRELATED,
  rumor: HANDSET_RUMOR_CAPPED,
};
