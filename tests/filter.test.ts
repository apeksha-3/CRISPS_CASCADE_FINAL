// tests/filter.test.ts
// The forward filter on hand-made evidence.

import { describe, expect, it } from "vitest";
import { PRIOR } from "../config/priors";
import { forwardFilter, type UnitUpdate, zeroRow } from "../engine/filter";
import { singleUnit } from "../engine/grouping";
import { EventLog } from "../engine/log";
import { buildCleanedWindow, offsetEstimates } from "../engine/order";
import type { CleanedEvent, Event, SourceStatus } from "../engine/types";
import { ev, REGISTRY } from "./helpers";

const allLive = Object.fromEntries(REGISTRY.sources.map((s) => [s.source_id, "live" as SourceStatus]));

function cleaned(events: Event[], now = 900) {
  const log = new EventLog();
  for (const e of events) log.append(e, now);
  return buildCleanedWindow(log, offsetEstimates(REGISTRY), now, 900, new Set());
}
// each fresh event as its own (single) evidence unit, never scored before
const units = (w: CleanedEvent[]): UnitUpdate[] => w.filter((e) => e.fresh).map((e) => ({ unit: singleUnit(e), previous: zeroRow() }));

describe("forward filter", () => {
  it("rain -> drainage -> traffic in one zone raises P(cascade)", () => {
    const chain = [
      ev({ source_id: "rain0", source_type: "rain_gauge", kind: "rain_heavy", arrived_at: 100 }),
      ev({ source_id: "drain0", source_type: "drainage_sensor", kind: "drainage_anomaly", arrived_at: 250 }),
      ev({ source_id: "traf0", source_type: "traffic_sensor", kind: "traffic_slowdown", arrived_at: 400 }),
    ];
    const w = cleaned(chain);
    expect(w.map((e) => e.chained)).toEqual([false, true, true]);
    const out = forwardFilter(PRIOR, units(w), allLive);
    expect(out.posterior.CASCADING_CRISIS).toBeGreaterThan(PRIOR.CASCADING_CRISIS);
    // the same three events in the WRONG causal order are less cascade-like
    const reversed = cleaned(chain.map((e, i) => ({ ...e, id: `r${i}`, occurred_at: 500 - e.occurred_at, arrived_at: 500 - e.arrived_at + 100 })));
    expect(reversed.map((e) => e.chained)).toEqual([false, false, false]);
    expect(forwardFilter(PRIOR, units(reversed), allLive).posterior.CASCADING_CRISIS).toBeLessThan(out.posterior.CASCADING_CRISIS);
  });

  it("gateway_heartbeat_lost pushes toward SENSOR_FAILURE", () => {
    const w = cleaned([ev({ source_id: "gw0", source_type: "gateway", gateway_id: "gw0", kind: "gateway_heartbeat_lost", arrived_at: 300 })]);
    const out = forwardFilter(PRIOR, units(w), allLive);
    expect(out.posterior.SENSOR_FAILURE).toBeGreaterThan(0.5);
    expect(out.posterior.CASCADING_CRISIS).toBeLessThan(PRIOR.CASCADING_CRISIS);
  });

  it("dark sources nudge toward SENSOR_FAILURE, and lost coverage widens toward the prior", () => {
    const half = { ...allLive, rain0: "dark", drain0: "dark", traf0: "dark" } as Record<string, SourceStatus>;
    const evidence = cleaned([ev({ source_id: "hosp1", source_type: "hospital", kind: "hospital_arrivals_unusual", zone_id: "z1", arrived_at: 300 })]);
    const live = forwardFilter(PRIOR, units(evidence), allLive);
    const dark = forwardFilter(PRIOR, units(evidence), half);
    expect(dark.raw.SENSOR_FAILURE).toBeGreaterThan(live.raw.SENSOR_FAILURE);
    expect(dark.coverage).toBeCloseTo(0.5, 9);
    // posterior = 0.5 * raw + 0.5 * prior
    expect(dark.posterior.NOISE).toBeCloseTo(0.5 * dark.raw.NOISE + 0.5 * PRIOR.NOISE, 9);
    // DEGRADED fires BELOW 0.5 (Phase 4): exactly half live is not degraded yet, 2 of 6 live is
    expect(dark.degraded).toBe(false);
    expect(live.degraded).toBe(false);
    expect(forwardFilter(PRIOR, units(evidence), { ...half, disp0: "dark" }).degraded).toBe(true);
  });

  it("only fresh events are scored, and a withdrawn (retracted) unit is subtracted back out", () => {
    const w = cleaned([ev({ source_id: "gw0", source_type: "gateway", gateway_id: "gw0", kind: "gateway_heartbeat_lost", arrived_at: 300 })]);
    const once = forwardFilter(PRIOR, units(w), allLive);
    const stale = w.map((e) => ({ ...e, fresh: false }));
    const nothing = forwardFilter(PRIOR, [], allLive);
    expect(forwardFilter(PRIOR, units(stale), allLive).raw).toEqual(nothing.raw);
    // an unchanged unit (same row as before) adds nothing
    const u = singleUnit(w[0]);
    const before = once.contributions.get(u.unit_id)!;
    expect(forwardFilter(PRIOR, [{ unit: u, previous: before }], allLive).raw).toEqual(nothing.raw);
    // every member retracted: n = 0, so its whole previous row is subtracted
    const undone = forwardFilter(once.raw, [{ unit: { ...u, n: 0, weight: 0 }, previous: before }], allLive);
    const back = forwardFilter(nothing.raw, [], allLive); // same number of predict steps, no evidence
    // not exact: the predict step in between mixes a little toward the base rates
    expect(once.raw.SENSOR_FAILURE).toBeGreaterThan(0.5);
    for (const h of Object.keys(PRIOR) as (keyof typeof PRIOR)[]) expect(Math.abs(undone.raw[h] - back.raw[h])).toBeLessThan(0.01);
  });

  it("probabilities always sum to 1", () => {
    const out = forwardFilter(PRIOR, units(cleaned([ev({ arrived_at: 100 }), ev({ arrived_at: 200, kind: "power_comms_load" })])), allLive);
    expect(Object.values(out.posterior).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
});
