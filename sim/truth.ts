// sim/truth.ts
// SIMULATOR-ONLY types. The hidden truth behind an episode.
// RULE: nothing under /engine may import this file (R8). Only /sim and /eval may.

import type {
  Event,
  EventKind,
  Gateway,
  Hypothesis,
  PublicRegistry,
  Seconds,
  SourceRegistryEntry,
  SourceType,
  Zone,
} from "../engine/types";

// A source as the simulator knows it, including facts the engine must estimate.
export interface SimSourceEntry extends SourceRegistryEntry {
  true_reliability: number; // hidden, 0..1 (may drift, see GroundTruth.drifting_sources)
  clock_offset: Seconds; // hidden, -120..+120 s (R9)
}

// The hidden world: like PublicRegistry but sources carry hidden fields.
export interface SimWorld {
  zones: Zone[];
  gateways: Gateway[];
  sources: SimSourceEntry[];
}

// Per-event hidden labels, in a side map keyed by event id.
export interface EventTruth {
  true_occurred_at: Seconds; // the real time it happened (sources only report a skewed clock)
  is_lie: boolean; // e.g. a lying gateway's identical fake readings
  is_mimic: boolean; // e.g. a rumor-wave report
  is_duplicate: boolean; // a different-id copy of one incident (duplicate storm)
  is_background: boolean; // normal-life blip, not part of any real happening
  retransmissions: number; // extra copies with the SAME id that were sent
  retracted: boolean; // a later retraction cancels this event
}

export type EpisodeType =
  | "noise"
  | "sensor_failure"
  | "isolated_incident"
  | "cascade"
  | "lookalike"
  | "twin"
  | "cutout"
  | "rumor_wave"
  | "duplicate_storm"
  | "surge"
  | "drifting";

export type LookalikeType = "rain_only" | "storm_calls" | "flu_cluster" | "gateway_outage";

// One real happening: e.g. "drainage stage active in zone z03 from 300 s".
export interface StageTruth {
  kind: EventKind;
  zone_id: string;
  start: Seconds;
  end: Seconds;
}

export interface GatewayFailureTruth {
  gateway_id: string;
  mode: "outage" | "lie";
  from: Seconds;
  to: Seconds;
  backlog: boolean; // outage only: buffered events arrive in a burst at `to`
}

export interface GroundTruth {
  hypothesis: Hypothesis; // ONE label for the whole episode
  episode_type: EpisodeType;
  lookalike?: LookalikeType; // which benign explanation (lookalikes, twin benign side)
  variant?: string; // e.g. "outage" / "lie", "flood" / "accident", "cameras" / "gateway"
  base_type?: EpisodeType; // for cutout / drifting: the episode they were applied to
  onset?: Seconds; // when the true situation began
  stage_times: Partial<Record<EventKind, Seconds>>; // first start of each stage
  stages: StageTruth[];
  critical_time?: Seconds; // cascade: when damage starts (first hospital stage)
  twin_pair_id?: string;
  twin_role?: "cascade" | "benign";
  split_time?: Seconds;
  build_attempt: number; // how many reseeds the builder needed (0 = first try)
  cutouts: { source_type?: SourceType; gateway_id?: string; from: Seconds; to: Seconds }[];
  failed_gateways: GatewayFailureTruth[];
  rumor?: { narrative_id: string; zone_id: string; from: Seconds; to: Seconds; reports: number; with_real_event: boolean };
  duplicate_storm?: { narrative_id: string; zone_id: string; reports: number };
  surge: boolean;
  drifting_sources: { source_id: string; from_reliability: number; to_reliability: number }[];
  weather: "normal" | "monsoon";
  sources: SimSourceEntry[]; // hidden reliability and clock offsets
  event_truths: Record<string, EventTruth>;
}

// A full simulated episode. The engine only ever receives `events` and
// `registry` (public). `truth` is for the simulator and the evaluator.
export interface Episode {
  episode_id: string;
  seed: number;
  type: EpisodeType;
  duration: Seconds;
  registry: PublicRegistry;
  events: Event[];
  truth: GroundTruth;
}

// Mapping of lookalikes to their labels (one true hypothesis per episode):
//   rain_only      -> NOISE           (heavy rain alone is normal city life)
//   storm_calls    -> NOISE           (normal storm emergency-call volume)
//   flu_cluster    -> NOISE           (hospital busy for a non-crisis reason)
//   gateway_outage -> SENSOR_FAILURE  (sensors quiet because their gateway broke)
export const LOOKALIKE_LABEL: Record<LookalikeType, Hypothesis> = {
  rain_only: "NOISE",
  storm_calls: "NOISE",
  flu_cluster: "NOISE",
  gateway_outage: "SENSOR_FAILURE",
};

// Strip hidden fields: what the engine is allowed to see about the world.
export function publicRegistry(world: SimWorld): PublicRegistry {
  return {
    zones: world.zones,
    gateways: world.gateways,
    sources: world.sources.map((s) => {
      const pub: SourceRegistryEntry = {
        source_id: s.source_id,
        source_type: s.source_type,
        zone_id: s.zone_id,
        heartbeat_interval_s: s.heartbeat_interval_s,
        nominal_latency_s: s.nominal_latency_s,
      };
      if (s.gateway_id !== undefined) pub.gateway_id = s.gateway_id;
      return pub;
    }),
  };
}
