// config/trust-priors.ts
// Starting trust per source type, as Beta(alpha, beta) (R4, engine/trust.ts).
// Mean trust = alpha / (alpha + beta). Small totals = "we don't know yet",
// so a few episodes of evidence move them a lot.
//   Beta(5, 1)  mean 0.83  known-reliable feeds: rain gauges, drainage sensors, hospitals,
//                          plus (our choice) official dispatch logs and the gateway monitor
//   Beta(2, 2)  mean 0.50  everything else: mildly uncertain
//   Beta(1, 2)  mean 0.33  citizen reports: skeptical until proven
// Hand-set (Phase 4 brief).

import type { SourceType } from "../engine/types";

export interface BetaParams {
  alpha: number;
  beta: number;
}

const RELIABLE: BetaParams = { alpha: 5, beta: 1 };
const UNSURE: BetaParams = { alpha: 2, beta: 2 };
const SKEPTICAL: BetaParams = { alpha: 1, beta: 2 };

export const TRUST_PRIORS: Record<SourceType, BetaParams> = {
  rain_gauge: RELIABLE,
  drainage_sensor: RELIABLE,
  hospital: RELIABLE,
  dispatch: RELIABLE, // official emergency-call logs (assumption: the brief listed rain, drainage, hospital)
  gateway: RELIABLE, // "gateway stopped pinging" comes from our own monitor (assumption, same reason)
  traffic_sensor: UNSURE,
  camera: UNSURE,
  utility: UNSURE,
  citizen_report: SKEPTICAL,
};

export const TRUST_KNOBS = {
  // Between episodes (ground truth revealed): old evidence is multiplied by this
  // first, so ancient history fades (0.98^50 = 0.36: half-life about 34 episodes).
  forgetting: 0.98,
  // Within an episode (no ground truth): an event that agrees with the current
  // leading hypothesis adds this much to its source's alpha.
  in_episode_step: 0.1,
  // An event "supports" a hypothesis when that hypothesis is within this many nats
  // of the top of the event's likelihood row (engine/trust.ts judgeEvent).
  judge_tolerance: 0.05,
};
