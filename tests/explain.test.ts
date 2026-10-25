// tests/explain.test.ts
// Template explanations (R7) and twin-prefix identity of the whole TickRecord.

import { describe, expect, it } from "vitest";
import { cascadeLLR } from "../engine/explain";
import { Engine } from "../engine/tick";
import { snapshot } from "../engine/trust";
import type { Event, TickRecord } from "../engine/types";
import { generateEpisode, generateTwinPair } from "../sim/episode";
import type { Episode } from "../sim/truth";
import { ev, REGISTRY } from "./helpers";

function play(ep: Episode): TickRecord[] {
  const engine = new Engine(ep.registry);
  const out: TickRecord[] = [];
  for (let t = 60; t <= ep.duration; t += 60) out.push(engine.tick(ep.events.filter((e) => e.arrived_at > t - 60 && e.arrived_at <= t), t));
  return out;
}

describe("explanations", () => {
  it("every tick has top evidence (<= 3, sorted by |LLR|), a delta summary and a forecast summary", () => {
    const recs = play(generateEpisode("cascade", 11));
    for (const r of recs) {
      expect(r.explanation.top_evidence.length).toBeLessThanOrEqual(3);
      const abs = r.explanation.top_evidence.map((e) => Math.abs(e.llr));
      expect(abs).toEqual(abs.slice().sort((a, b) => b - a));
      expect(r.explanation.delta_summary.length).toBeGreaterThan(10);
      expect(r.explanation.forecast_summary.length).toBeGreaterThan(10);
    }
    const late = recs.find((r) => r.probabilities.CASCADING_CRISIS > 0.5)!;
    expect(late.explanation.top_evidence).toHaveLength(3);
    expect(late.explanation.top_evidence[0].supports).toBe("CASCADING_CRISIS");
    expect(recs.some((r) => /P\(cascade\) rose from [0-9.]+ to [0-9.]+ because /.test(r.explanation.delta_summary))).toBe(true);
    const withForecast = recs.filter((r) => r.forecast.length > 0);
    expect(withForecast.length).toBeGreaterThan(0);
    for (const r of withForecast) expect(r.explanation.forecast_summary).toContain(r.forecast[0].kind);
  });

  it("handles a retraction inside a cluster: 'Revised: event X was retracted ...'", () => {
    // a fully trusted traffic sensor, so one retraction visibly moves the belief
    const engine = new Engine(REGISTRY, { trust: { traf0: snapshot("traf0", "traffic_sensor", { alpha: 20, beta: 0 }) } });
    const five = [10, 20, 30, 40, 50].map((dt, i) => ev({ id: `c${i}`, arrived_at: 60 + dt, value: 50 + i }));
    const first = engine.tick(five, 120);
    expect(first.clusters).toBe(1);
    const retraction: Event = { id: "r1", source_id: "traf0", source_type: "traffic_sensor", zone_id: "z0", kind: "retraction", occurred_at: 170, arrived_at: 175, retracts: "c2" };
    const next = engine.tick([retraction], 180);
    expect(next.explanation.delta_summary).toMatch(/^Revised: event c2 was retracted, (reducing|raising) P\(\w+\) by 0\.\d\d/);
    expect(engine.units()[0].n).toBe(4);
  });

  it("says when nothing changed", () => {
    const engine = new Engine(REGISTRY);
    engine.tick([], 60);
    engine.tick([], 120); // the 10% prior cascade rate makes PREPARE the cheapest action from the start
    expect(engine.tick([], 180).explanation.delta_summary).toBe("No new evidence this tick, holding at PREPARE.");
  });

  it("says when a gateway goes dark", () => {
    const engine = new Engine(REGISTRY);
    const lost = ev({ source_id: "gw0", source_type: "gateway", gateway_id: "gw0", kind: "gateway_heartbeat_lost", arrived_at: 100 });
    expect(engine.tick([lost], 120).explanation.delta_summary).toMatch(/Gateway gw0 lost: 3 sensors now dark, confidence widened/);
  });

  it("LLR: positive for evidence typical of a cascade, negative against, 0 for nothing", () => {
    const p = { NOISE: 0.55, SENSOR_FAILURE: 0.15, ISOLATED_INCIDENT: 0.2, CASCADING_CRISIS: 0.1 };
    expect(cascadeLLR({ NOISE: 0, SENSOR_FAILURE: 0, ISOLATED_INCIDENT: 0, CASCADING_CRISIS: 0.8 }, p)).toBeCloseTo(0.8, 9);
    expect(cascadeLLR({ NOISE: 0, SENSOR_FAILURE: 2, ISOLATED_INCIDENT: 0, CASCADING_CRISIS: 0 }, p)).toBeLessThan(0);
    expect(cascadeLLR({ NOISE: 0, SENSOR_FAILURE: 0, ISOLATED_INCIDENT: 0, CASCADING_CRISIS: 0 }, p)).toBeCloseTo(0, 12);
  });
});

describe("twin test (R1) with the Phase 3 engine", () => {
  it("both twins get byte-identical records (belief, action, forecast, explanation) up to the split", () => {
    const [a, b] = generateTwinPair(7);
    const split = a.truth.split_time!;
    const ra = play(a).filter((r) => r.tick_time <= split);
    const rb = play(b).filter((r) => r.tick_time <= split);
    expect(ra.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
  });
});
