// tests/log.test.ts
// Event log: future refusal, dedupe by id, retractions including orphans.

import { describe, expect, it } from "vitest";
import { EventLog } from "../engine/log";
import { ev } from "./helpers";

describe("event log", () => {
  it("refuses events that have not arrived yet", () => {
    const log = new EventLog();
    expect(log.append(ev({ arrived_at: 700 }), 600)).toBe("future");
    expect(log.size()).toBe(0);
  });
  it("deduplicates by id", () => {
    const log = new EventLog();
    const a = ev({ arrived_at: 100 });
    expect(log.append(a, 600)).toBe("added");
    expect(log.append({ ...a, arrived_at: 150 }, 600)).toBe("duplicate");
    expect(log.activeEvents(0, 600)).toHaveLength(1);
  });
  it("getWindow uses arrived_at for the range and sorts by occurred_at", () => {
    const log = new EventLog();
    const late = ev({ arrived_at: 300, occurred_at: 50 });
    const early = ev({ arrived_at: 200, occurred_at: 190 });
    const old = ev({ arrived_at: 10 });
    for (const e of [old, early, late]) log.append(e, 600);
    expect(log.getWindow(100, 600).map((e) => e.id)).toEqual([late.id, early.id]);
  });
  it("activeEvents excludes retracted events", () => {
    const log = new EventLog();
    const a = ev({ arrived_at: 100 });
    log.append(a, 600);
    log.append(ev({ arrived_at: 130, kind: "retraction", retracts: a.id }), 600);
    expect(log.getWindow(0, 600).map((e) => e.id)).toContain(a.id);
    expect(log.activeEvents(0, 600).map((e) => e.id)).not.toContain(a.id);
  });
  it("orphan retraction waits, then applies when its target arrives", () => {
    const log = new EventLog();
    const target = ev({ arrived_at: 400 });
    log.append(ev({ arrived_at: 100, kind: "retraction", retracts: target.id }), 120);
    expect(log.pendingRetractions()).toBe(1);
    log.append(target, 420);
    expect(log.applyPendingRetractions()).toEqual([target.id]);
    expect(log.pendingRetractions()).toBe(0);
    expect(log.activeEvents(0, 420).map((e) => e.id)).not.toContain(target.id);
  });
});
