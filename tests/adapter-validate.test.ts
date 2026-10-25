// tests/adapter-validate.test.ts
// Adapter: maps other schemas, returns null for non-events.
// Validator: quarantines broken events, but lets clock-skewed ones through.

import { describe, expect, it } from "vitest";
import { adaptEvent } from "../engine/adapter";
import { validateEvent } from "../engine/validate";
import { ev, REGISTRY } from "./helpers";

const ctx = { now: 600, zones: new Set(REGISTRY.zones.map((z) => z.zone_id)) };

describe("adapter", () => {
  it("returns null for input that is not an event", () => {
    for (const bad of [null, undefined, 42, "hello", [1, 2], {}, { foo: 1 }]) expect(adaptEvent(bad)).toBeNull();
  });
  it("passes our own schema through unchanged", () => {
    const e = ev({ arrived_at: 100, value: 55 });
    expect(adaptEvent(e)).toEqual(e);
  });
  it("renames fields and coerces types from another schema", () => {
    const raw = { event_id: "x1", sensor_id: "traf0", sourceType: "traffic_sensor", zone: "z0", type: "traffic_slowdown", reading: "61.5", severity: "0.7", timestamp: "100", received_at: 130 };
    expect(adaptEvent(raw)).toEqual({ id: "x1", source_id: "traf0", source_type: "traffic_sensor", zone_id: "z0", kind: "traffic_slowdown", value: 61.5, reported_severity: 0.7, occurred_at: 100, arrived_at: 130 });
  });
});

describe("validator", () => {
  const reason = (e: ReturnType<typeof ev>) => {
    const r = validateEvent(e, ctx);
    return "quarantined" in r ? r.reason : "valid";
  };
  it("accepts a normal event", () => expect(reason(ev({ arrived_at: 100 }))).toBe("valid"));
  it("quarantines NaN and non-finite numbers", () => {
    expect(reason(ev({ arrived_at: 100, value: Number.NaN }))).toMatch(/value/);
    expect(reason(ev({ arrived_at: 100, reported_severity: Infinity }))).toMatch(/reported_severity/);
  });
  it("quarantines events that arrive in the future (vs the engine clock)", () => {
    expect(reason(ev({ arrived_at: 601 }))).toMatch(/future/);
  });
  it("quarantines missing required fields", () => {
    for (const f of ["id", "source_id", "source_type", "kind", "arrived_at"] as const) {
      const e = ev({ arrived_at: 100 }) as unknown as Record<string, unknown>;
      delete e[f];
      expect(reason(e as never), f).toMatch(new RegExp(`missing ${f}`));
    }
  });
  it("quarantines unknown kinds and unknown zones", () => {
    expect(reason(ev({ arrived_at: 100, kind: "alien_signal" as never }))).toMatch(/unknown kind/);
    expect(reason(ev({ arrived_at: 100, zone_id: "z99" }))).toMatch(/unknown zone/);
  });
  it("does NOT quarantine clock skew (occurred_at after arrived_at)", () => {
    expect(reason(ev({ arrived_at: 100, occurred_at: 220 }))).toBe("valid");
  });
});
