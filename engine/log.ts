// engine/log.ts
// The append-only event log. One copy of every event the engine has received,
// in arrival order. Nothing is ever deleted: a retraction only MARKS its target.
//
//   append(e, now)  'added' | 'duplicate' (same id seen before, skipped) | 'future' (arrived_at > now, refused: R8)
//   retract(id)     mark id as retracted; if id has not arrived yet, remember it (orphan retraction)
//   applyPendingRetractions()  after a batch: orphans whose target has now arrived get applied
//   getWindow(from, to)     events with from < arrived_at <= to, sorted by occurred_at
//   activeEvents(from, to)  the same, minus retracted events
//
// Storage: a plain array plus a Map from id to array index. No database.

import type { Event, Seconds } from "./types";

export type AppendResult = "added" | "duplicate" | "future";

const byOccurred = (a: Event, b: Event) => a.occurred_at - b.occurred_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class EventLog {
  private events: Event[] = [];
  private index = new Map<string, number>();
  private retracted = new Set<string>();
  private pending = new Set<string>(); // retraction targets not seen yet

  append(e: Event, now: Seconds): AppendResult {
    if (e.arrived_at > now) return "future";
    if (this.index.has(e.id)) return "duplicate";
    this.index.set(e.id, this.events.length);
    this.events.push(e);
    if (e.kind === "retraction" && e.retracts) this.retract(e.retracts);
    return "added";
  }

  retract(targetId: string): void {
    if (this.index.has(targetId)) this.retracted.add(targetId);
    else this.pending.add(targetId);
  }

  // Returns the ids that just became retracted.
  applyPendingRetractions(): string[] {
    const done: string[] = [];
    for (const id of [...this.pending].sort()) {
      if (!this.index.has(id)) continue;
      this.retracted.add(id);
      this.pending.delete(id);
      done.push(id);
    }
    return done;
  }

  isRetracted(id: string): boolean {
    return this.retracted.has(id);
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  pendingRetractions(): number {
    return this.pending.size;
  }

  size(): number {
    return this.events.length;
  }

  getWindow(from: Seconds, to: Seconds): Event[] {
    return this.events.filter((e) => e.arrived_at > from && e.arrived_at <= to).sort(byOccurred);
  }

  activeEvents(from: Seconds, to: Seconds): Event[] {
    return this.getWindow(from, to).filter((e) => !this.retracted.has(e.id));
  }

  // Everything received so far, in arrival order (for the fallback baseline).
  all(): Event[] {
    return this.events.slice();
  }
}
