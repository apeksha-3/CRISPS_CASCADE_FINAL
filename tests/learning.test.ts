// tests/learning.test.ts
// Phase 4: per-source Beta trust, learned base rates, CUSUM drift, the
// between-episode learning loop, and trust-weighted DEGRADED.

import { describe, expect, it } from "vitest";
import { PRIOR } from "../config/priors";
import { DEFAULT_FILTER_CONFIG, forwardFilter } from "../engine/filter";
import { initialDriftState, updateDrift } from "../engine/drift";
import { currentPrior, initialLearnedState, type LearnedState, updateAfterEpisode } from "../engine/learn";
import { initialPriorState, priorVector, startFastForgetting, updatePrior } from "../engine/priors";
import { singleUnit } from "../engine/grouping";
import { Engine } from "../engine/tick";
import { geometricMean, judgeEvent, snapshot, type SourceEvidence, type TrustState, updateTrust } from "../engine/trust";
import type { Hypothesis, PublicRegistry, SourceStatus, SourceType } from "../engine/types";
import { ce } from "./helpers";

const ev = (source_id: string, i: number, source_type: SourceType = "citizen_report"): SourceEvidence => ({
  event_id: `${source_id}-${i}`,
  source_id,
  source_type,
  row: { NOISE: 0, SENSOR_FAILURE: 0, ISOLATED_INCIDENT: 0.3, CASCADING_CRISIS: 0.1 },
});
const five = (id: string) => [0, 1, 2, 3, 4].map((i) => ev(id, i));

describe("per-source Beta trust", () => {
  it("5 supporting events raise trust, 5 misleading events lower it", () => {
    const start: TrustState = { c1: snapshot("c1", "citizen_report", { alpha: 2, beta: 2 }) };
    const up = updateTrust(start, five("c1"), "ISOLATED_INCIDENT", () => true);
    const down = updateTrust(start, five("c1"), "ISOLATED_INCIDENT", () => false);
    expect(up.c1.mean).toBeGreaterThan(start.c1.mean);
    expect(down.c1.mean).toBeLessThan(start.c1.mean);
    // 2 x 0.98 + 5 = 6.96 vs 1.96: trust 0.78; mirrored: 0.22
    expect(up.c1.mean).toBeCloseTo(6.96 / 8.92, 6);
    expect(down.c1.mean).toBeCloseTo(1.96 / 8.92, 6);
    // with no event labels, the outcome alone decides (the row points at ISOLATED)
    expect(updateTrust(start, five("c1"), "ISOLATED_INCIDENT").c1.mean).toBeGreaterThan(start.c1.mean);
    expect(updateTrust(start, five("c1"), "NOISE").c1.mean).toBeLessThan(start.c1.mean);
    expect(judgeEvent(ev("x", 0).row, "SENSOR_FAILURE")).toBe("mislead");
  });

  it("forgetting: (100, 1) after 50 episodes with no news is about (36.4, 0.36): still trusted, less extreme", () => {
    let s: TrustState = { h: snapshot("h", "hospital", { alpha: 100, beta: 1 }) };
    for (let i = 0; i < 50; i++) s = updateTrust(s, [], "NOISE");
    expect(s.h.alpha).toBeCloseTo(100 * 0.98 ** 50, 6);
    expect(s.h.alpha).toBeCloseTo(36.4, 1);
    expect(s.h.beta).toBeCloseTo(0.364, 3);
    expect(s.h.mean).toBeCloseTo(100 / 101, 9); // the mean is unchanged; only the certainty fades
    // ...so new evidence now moves it faster than it would have before
    const fresh = updateTrust(s, five("h").map((e) => ({ ...e, source_type: "hospital" as SourceType })), "NOISE", () => false);
    const old = updateTrust({ h: snapshot("h", "hospital", { alpha: 100, beta: 1 }) }, five("h"), "NOISE", () => false);
    expect(fresh.h.mean).toBeLessThan(old.h.mean);
  });

  it("geometric mean of a cluster's sources: 0.9, 0.5, 0.3 -> about 0.51", () => {
    expect(geometricMean([0.9, 0.5, 0.3])).toBeCloseTo(Math.cbrt(0.9 * 0.5 * 0.3), 9);
    expect(geometricMean([0.9, 0.5, 0.3])).toBeCloseTo(0.513, 3);
    // and the unit really uses it: 3 sources in one near-duplicate cluster
    const t: Record<string, number> = { a: 0.9, b: 0.5, c: 0.3 };
    const u = singleUnit(ce({ source_id: "a", arrived_at: 100 }));
    expect(u.trust).toBeCloseTo(0.5, 9); // a traffic sensor's type prior, Beta(2, 2)
    expect(geometricMean(["a", "b", "c"].map((s) => t[s]))).toBeLessThan((0.9 + 0.5 + 0.3) / 3); // one weak source drags it down more than an average would
  });

  it("within an episode, a source whose events agree with the leading hypothesis gains a little trust", () => {
    const reg: PublicRegistry = {
      zones: [{ zone_id: "z0", name: "Harbor", neighbours: [] }],
      gateways: [],
      sources: [{ source_id: "hosp0", source_type: "hospital", zone_id: "z0", heartbeat_interval_s: 300, nominal_latency_s: 60 }],
    };
    const engine = new Engine(reg);
    const before = engine.trustState().hosp0.alpha;
    // hospital arrivals with no calls before: flu-like, the row points at NOISE, which leads
    engine.tick([{ id: "h1", source_id: "hosp0", source_type: "hospital", zone_id: "z0", kind: "hospital_arrivals_unusual", occurred_at: 30, arrived_at: 50, reported_severity: 0.8 }], 60);
    expect(engine.trustState().hosp0.alpha).toBeCloseTo(before + 0.1, 9);
    expect(engine.sourceEvidence()).toHaveLength(1);
  });
});

describe("learned base rates (decayed counts)", () => {
  it("starts at the configured base rates", () => {
    const p = priorVector(initialPriorState());
    for (const h of Object.keys(PRIOR) as Hypothesis[]) expect(p[h]).toBeCloseTo(PRIOR[h], 9);
  });

  it("after 10 cascade episodes in a row, P(CASCADE) a priori exceeds 0.3 (and nothing drops below 2%)", () => {
    let s = initialPriorState();
    for (let i = 0; i < 10; i++) s = updatePrior(s, "CASCADING_CRISIS");
    const p = priorVector(s);
    expect(p.CASCADING_CRISIS).toBeGreaterThan(0.3);
    let t = initialPriorState();
    for (let i = 0; i < 300; i++) t = updatePrior(t, "NOISE");
    expect(Math.min(...Object.values(priorVector(t)))).toBeGreaterThanOrEqual(0.02 - 1e-12);
  });
});

describe("CUSUM drift detector", () => {
  // The cascade share steps up from about 8% to 50%; the full learning loop runs.
  const normal: Hypothesis[] = Array.from({ length: 40 }, (_, i) => (i % 12 === 5 ? "CASCADING_CRISIS" : "NOISE"));
  const monsoon: Hypothesis[] = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "CASCADING_CRISIS" : "NOISE"));

  it("stays quiet in the normal regime and fires within 10 episodes of the step", () => {
    let s: LearnedState = initialLearnedState();
    for (const h of normal) s = updateAfterEpisode(s, h, []);
    expect(s.drift.alarms).toEqual([]);
    for (const h of monsoon) s = updateAfterEpisode(s, h, []);
    expect(s.drift.alarms.length).toBeGreaterThan(0);
    expect(s.drift.alarms[0]).toBeGreaterThan(40);
    expect(s.drift.alarms[0]).toBeLessThanOrEqual(50);
    expect(s.log[0]).toMatch(/CUSUM drift alarm/);
  });

  it("S = max(0, S + residual - k): a non-cascade episode never pushes S below 0", () => {
    expect(updateDrift(initialDriftState(), "NOISE", 0.1).state.S).toBe(0);
    expect(updateDrift(initialDriftState(), "CASCADING_CRISIS", 0.1).state.S).toBeCloseTo(0.85, 9);
  });

  it("after an alarm the prior moves faster (measured 5 episodes later)", () => {
    const base = initialPriorState();
    let slow = base;
    let fast = startFastForgetting(base);
    for (let i = 0; i < 5; i++) {
      slow = updatePrior(slow, "CASCADING_CRISIS");
      fast = updatePrior(fast, "CASCADING_CRISIS");
    }
    // slow (0.95): 0.30;  fast (0.8): 0.41
    expect(priorVector(fast).CASCADING_CRISIS).toBeGreaterThan(priorVector(slow).CASCADING_CRISIS + 0.08);
    expect(fast.fast_left).toBe(5);
  });
});

describe("learning loop isolation", () => {
  it("the outcome is only an argument of updateAfterEpisode; the engine gets trust + prior at the start", () => {
    let s = initialLearnedState();
    s = updateAfterEpisode(s, "CASCADING_CRISIS", [ev("c9", 0)], undefined, () => true);
    expect(currentPrior(s).CASCADING_CRISIS).toBeGreaterThan(PRIOR.CASCADING_CRISIS);
    expect(s.trust.c9.alpha).toBeCloseTo(1 + 1, 9); // never seen before: citizen type prior Beta(1, 2), then +1
    // Engine takes no outcome: its constructor options are prior / trust / tables only
    const e = new Engine({ zones: [], gateways: [], sources: [] }, { prior: currentPrior(s), trust: s.trust });
    expect(e.tick([], 60).probabilities.CASCADING_CRISIS).toBeGreaterThan(PRIOR.CASCADING_CRISIS);
  });
});

describe("DEGRADED with trust-weighted coverage", () => {
  const reg: PublicRegistry = {
    zones: [{ zone_id: "z0", name: "Harbor", neighbours: [] }],
    gateways: [],
    sources: [
      ...[0, 1, 2, 3].map((i) => ({ source_id: `hsp${i}`, source_type: "hospital" as SourceType, zone_id: "z0", heartbeat_interval_s: 300, nominal_latency_s: 60 })),
      ...[0, 1, 2, 3].map((i) => ({ source_id: `rain${i}`, source_type: "rain_gauge" as SourceType, zone_id: "z0", heartbeat_interval_s: 300, nominal_latency_s: 15 })),
      ...Array.from({ length: 12 }, (_, i) => ({ source_id: `cit${i}`, source_type: "citizen_report" as SourceType, zone_id: "z0", heartbeat_interval_s: 300, nominal_latency_s: 60 })),
    ],
  };

  it("fires when hospitals and rain gauges go dark, even though 12 of 20 sources (60%) are still live", () => {
    const statuses: Record<string, SourceStatus> = Object.fromEntries(reg.sources.map((s) => [s.source_id, s.source_type === "citizen_report" ? "live" : "dark"]));
    const weights = Object.fromEntries(reg.sources.map((s) => [s.source_id, s.source_type === "citizen_report" ? 1 / 3 : 5 / 6]));
    const plain = forwardFilter(PRIOR, [], statuses);
    expect(plain.coverage).toBeCloseTo(0.6, 9);
    expect(plain.degraded).toBe(false); // a head count says "fine"
    const weighted = forwardFilter(PRIOR, [], statuses, { ...DEFAULT_FILTER_CONFIG, coverageWeights: weights });
    expect(weighted.coverage).toBeCloseTo(4 / (4 + 40 / 6), 9); // 12 x 1/3 live out of 12 x 1/3 + 8 x 5/6
    expect(weighted.degraded).toBe(true);
  });

  it("does not fire when the same number of citizen channels go dark instead", () => {
    const statuses: Record<string, SourceStatus> = Object.fromEntries(reg.sources.map((s) => [s.source_id, s.source_id.startsWith("cit") && Number(s.source_id.slice(3)) < 8 ? "dark" : "live"]));
    const weights = Object.fromEntries(reg.sources.map((s) => [s.source_id, s.source_type === "citizen_report" ? 1 / 3 : 5 / 6]));
    expect(forwardFilter(PRIOR, [], statuses, { ...DEFAULT_FILTER_CONFIG, coverageWeights: weights }).degraded).toBe(false);
  });

  it("in the engine: the weights come from the trust snapshot", () => {
    const e = new Engine(reg);
    let rec = e.tick([], 60);
    for (let t = 120; t <= 1500; t += 60) {
      // only citizens keep sending heartbeats
      const beats = reg.sources.filter((s) => s.source_type === "citizen_report").map((s) => ({ id: `hb-${s.source_id}-${t}`, source_id: s.source_id, source_type: s.source_type, zone_id: "z0", kind: "heartbeat" as const, occurred_at: t - 5, arrived_at: t - 1 }));
      rec = e.tick(beats, t);
    }
    expect(rec.source_summary.coverage).toBeCloseTo(0.6, 9);
    expect(rec.degraded).toBe(true);
  });
});
