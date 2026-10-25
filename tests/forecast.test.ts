// tests/forecast.test.ts
// The causal-chain forecast: causal order, time windows, confirmation bonus, lookahead.

import { describe, expect, it } from "vitest";
import { CAUSAL_EDGES, CAUSAL_ORDER } from "../config/causal-graph";
import { FORECAST_KNOBS } from "../config/knobs";
import { PRIOR } from "../config/priors";
import { decide, initialDecisionState } from "../engine/decide";
import { forwardFilter } from "../engine/filter";
import { checkForecasts, forecastLines, initialForecastState, type Lookahead, updateStages, visibleForecast } from "../engine/forecast";
import { toUnit } from "../engine/grouping";
import { Engine } from "../engine/tick";
import type { Action, Event, ProbabilityVector, SourceStatus } from "../engine/types";
import { ce, ev, REGISTRY } from "./helpers";

const pv = (n: number, s: number, i: number, c: number): ProbabilityVector => ({ NOISE: n, SENSOR_FAILURE: s, ISOLATED_INCIDENT: i, CASCADING_CRISIS: c });
const unitOf = (e: ReturnType<typeof ce>) => toUnit({ id: e.id, key: e.id, type: "near_duplicate", kind: e.kind, zone_id: e.zone_id, anchor_t: e.adjusted_occurred_at, members: [e], corroborated: false });
const rain = ce({ arrived_at: 110, source_id: "rain0", source_type: "rain_gauge", kind: "rain_heavy" }); // adjusted t = 100
const drain = ce({ arrived_at: 290, source_id: "drain0", source_type: "drainage_sensor", kind: "drainage_anomaly", chained: true }); // t = 280

describe("causal-chain forecast", () => {
  it("given rain + drainage, predicts traffic_slowdown next, in causal order, with a time window", () => {
    const st = initialForecastState();
    expect(updateStages(st, [unitOf(rain), unitOf(drain)], 300)).toEqual(["rain_heavy", "drainage_anomaly"]);
    const posterior = pv(0.5, 0.1, 0.1, 0.3);
    const lines = forecastLines(st, posterior);
    expect(lines.map((l) => l.kind)).toEqual(CAUSAL_ORDER.slice(2)); // traffic, calls, hospital, power
    const traffic = lines[0];
    // expected = drainage seen (280) + the drainage -> traffic lag mean; sd = sqrt(lag sd^2 + 2 * 90^2)
    // (the lag was measured on dev by `npm run tune`, config/lags.ts; hand-set it was 120 +/- 45)
    const lag = CAUSAL_EDGES.find((e) => e.to === "traffic_slowdown")!.lag;
    expect(traffic.expected_at).toBe(Math.round(280 + lag.mean));
    const sd = Math.sqrt(lag.sd ** 2 + 2 * FORECAST_KNOBS.detection_sd_s ** 2);
    expect(traffic.window_p10).toBe(Math.round(280 + lag.mean - FORECAST_KNOBS.window_z * sd));
    expect(traffic.window_p90).toBe(Math.round(280 + lag.mean + FORECAST_KNOBS.window_z * sd));
    expect(traffic.probability).toBeCloseTo(0.3 * 0.9, 9); // P(cascade) x pass-through
    // later stages: later and wider windows, lower probability
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].expected_at).toBeGreaterThan(lines[i - 1].expected_at);
      expect(lines[i].window_p90 - lines[i].window_p10).toBeGreaterThan(lines[i - 1].window_p90 - lines[i - 1].window_p10);
      expect(lines[i].probability).toBeLessThan(lines[i - 1].probability);
    }
    expect(visibleForecast(lines, st, 300)).toHaveLength(3);
  });

  it("lying gateways and rumors never count as a stage; non-root kinds must be chained", () => {
    const st = initialForecastState();
    const unchainedDrain = unitOf({ ...drain, chained: false });
    const rumor = { ...unitOf(rain), unit_type: "narrative" as const };
    const lie = { ...unitOf(rain), unit_type: "gateway_correlated" as const };
    expect(updateStages(st, [unchainedDrain, rumor, lie], 300)).toEqual([]);
    expect(forecastLines(st, PRIOR)).toEqual([]);
  });

  it("forecast confirmation bonus: the predicted stage arriving inside its window adds to CASCADE", () => {
    const st = initialForecastState();
    updateStages(st, [unitOf(rain), unitOf(drain)], 300);
    st.lines = forecastLines(st, PRIOR);
    const traffic = unitOf(ce({ arrived_at: 420, source_id: "traf0", source_type: "traffic_sensor", kind: "traffic_slowdown", chained: true })); // t = 410, in window
    const fresh = updateStages(st, [unitOf(rain), unitOf(drain), traffic], 420);
    const out = checkForecasts(st, fresh, 420, 1);
    expect(out).toEqual([{ kind: "traffic_slowdown", outcome: "confirmed", ll: { NOISE: 0, SENSOR_FAILURE: 0, ISOLATED_INCIDENT: 0, CASCADING_CRISIS: FORECAST_KNOBS.confirm_bonus_ll } }]);
    const live = Object.fromEntries(REGISTRY.sources.map((s) => [s.source_id, "live" as SourceStatus]));
    expect(forwardFilter(PRIOR, [], live, undefined, [out[0].ll]).posterior.CASCADING_CRISIS).toBeGreaterThan(forwardFilter(PRIOR, [], live).posterior.CASCADING_CRISIS);
  });

  it("a missed forecast (window passed, nothing seen) counts against CASCADE, less so when sensors are dark", () => {
    const st = initialForecastState();
    updateStages(st, [unitOf(rain), unitOf(drain)], 300);
    st.lines = forecastLines(st, PRIOR);
    const late = st.lines[0].window_p90 + FORECAST_KNOBS.detection_slack_s + 1;
    const missed = checkForecasts(structuredClone(st), [], late, 1);
    expect(missed[0]).toMatchObject({ kind: "traffic_slowdown", outcome: "missed" });
    expect(missed[0].ll.CASCADING_CRISIS).toBeLessThan(0);
    const halfDark = checkForecasts(structuredClone(st), [], late, 0.5);
    expect(halfDark[0].ll.CASCADING_CRISIS).toBeGreaterThan(missed[0].ll.CASCADING_CRISIS);
  });

  it("in the engine: rain -> drainage -> traffic on schedule gives a higher P(cascade) with the bonus than without", () => {
    const chain: Event[] = [
      ev({ id: "r1", source_id: "rain0", source_type: "rain_gauge", kind: "rain_heavy", arrived_at: 100 }),
      ev({ id: "d1", source_id: "drain0", source_type: "drainage_sensor", kind: "drainage_anomaly", arrived_at: 290 }),
      ev({ id: "t1", source_id: "traf0", source_type: "traffic_sensor", kind: "traffic_slowdown", arrived_at: 420 }),
    ];
    const play = () => {
      const eng = new Engine(REGISTRY);
      const recs = [60, 120, 180, 240, 300, 360, 420, 480].map((t) => eng.tick(chain.filter((e) => e.arrived_at > t - 60 && e.arrived_at <= t), t));
      return recs.at(-2)!; // t = 420, the traffic tick
    };
    const withBonus = play();
    const saved = FORECAST_KNOBS.confirm_bonus_ll;
    FORECAST_KNOBS.confirm_bonus_ll = 0;
    let without;
    try {
      without = play();
    } finally {
      FORECAST_KNOBS.confirm_bonus_ll = saved;
    }
    expect(withBonus.explanation.delta_summary).toMatch(/the forecast traffic_slowdown arrived on schedule/);
    expect(withBonus.probabilities.CASCADING_CRISIS).toBeGreaterThan(without.probabilities.CASCADING_CRISIS);
    expect(withBonus.forecast[0].kind).toBe("emergency_call_spike");
  });
});

describe("one-step lookahead in the decision", () => {
  const atPrepare = { ...initialDecisionState(), current: "PREPARE" as Action, ticks_at_current: 10 };
  const edge = pv(0.5, 0.05, 0.05, 0.4); // ALERT is optimal, PREPARE close behind
  const calm = pv(0.95, 0.03, 0.02, 0);
  it("defers an upgrade one tick when the forecast says the evidence is about to fade", () => {
    const fading: Lookahead = { kind: "hospital_arrivals_unusual", q: 0.05, ifArrives: edge, ifNot: calm };
    const run = (la?: Lookahead) => {
      let s = atPrepare;
      return [edge, edge, edge, edge].map((p) => {
        const d = decide(p, s, undefined, la);
        s = d.state;
        return `${d.action}${d.lookahead === "deferred" ? "*" : ""}`;
      });
    };
    expect(run()).toEqual(["PREPARE", "ALERT", "ALERT", "ALERT"]);
    // never two deferrals in a row; deferred ticks neither count toward nor break the 2-tick streak
    expect(run(fading)).toEqual(["PREPARE*", "PREPARE", "PREPARE*", "ALERT"]);
  });
  it("anticipates: an imminent, decisive forecast counts as the first of the 2 'above' ticks", () => {
    const atWatch = initialDecisionState();
    const quiet = pv(0.9, 0.04, 0.04, 0.02); // WATCH optimal
    const alerty = pv(0.4, 0.05, 0.05, 0.5);
    const imminent: Lookahead = { kind: "hospital_arrivals_unusual", q: 0.9, ifArrives: alerty, ifNot: quiet };
    const a1 = decide(quiet, atWatch, undefined, imminent);
    expect(a1.action).toBe("WATCH");
    expect(a1.lookahead).toBe("anticipated");
    expect(decide(alerty, a1.state).action).toBe("ALERT"); // second tick really above: upgrade now, not a tick later
    const b1 = decide(quiet, atWatch);
    expect(decide(alerty, b1.state).action).toBe("WATCH"); // without the forecast: only the first "above" tick
  });
});
