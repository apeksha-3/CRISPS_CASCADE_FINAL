// tests/source-status.test.ts
// live -> stale -> dark as the silence grows; gateway loss makes its sensors dark at once.

import { describe, expect, it } from "vitest";
import { SourceTracker } from "../engine/source-status";
import { ev, REGISTRY } from "./helpers";

describe("source status", () => {
  it("goes live -> stale -> dark with heartbeat gaps (2x and 4x the 300 s interval)", () => {
    const t = new SourceTracker(REGISTRY);
    t.observe(ev({ source_id: "disp0", kind: "heartbeat", arrived_at: 100 }));
    expect(t.statuses(100 + 599).disp0).toBe("live");
    expect(t.statuses(100 + 600).disp0).toBe("stale");
    expect(t.statuses(100 + 1199).disp0).toBe("stale");
    expect(t.statuses(100 + 1200).disp0).toBe("dark");
    t.observe(ev({ source_id: "disp0", kind: "heartbeat", arrived_at: 1400 }));
    expect(t.statuses(1400).disp0).toBe("live"); // back
  });
  it("a gateway_heartbeat_lost makes every sensor behind it dark immediately", () => {
    const t = new SourceTracker(REGISTRY);
    t.observe(ev({ source_id: "gw0", source_type: "gateway", gateway_id: "gw0", kind: "gateway_heartbeat_lost", arrived_at: 200 }));
    const s = t.statuses(210);
    expect([s.rain0, s.drain0, s.traf0]).toEqual(["dark", "dark", "dark"]);
    expect(s.disp0).toBe("live"); // not behind the gateway
    expect(t.coverage(210)).toBeCloseTo(3 / 6, 9);
    t.observe(ev({ source_id: "rain0", kind: "heartbeat", arrived_at: 900 }));
    expect(t.statuses(900).rain0).toBe("live"); // heard from again after the loss
  });
});
