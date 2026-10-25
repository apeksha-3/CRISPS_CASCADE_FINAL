// sim/noise.ts
// Delivery: turns drafts (true time) into the messy Event stream the engine sees.
//   - occurred_at = the SOURCE's clock = true time + hidden clock_offset
//   - arrived_at  = engine clock = true time + delivery delay (5-90 s, sometimes 1-2 min late)
//   - retransmissions (same id again), retractions (some arrive BEFORE their target),
//     gateway outages / cutouts (lost, or buffered then dumped as a backlog burst),
//     out-of-order arrival (falls out of the random delays), optional fuzz.
// Each draft uses its own random stream, so one draft's noise never shifts another's.

import type { Event } from "../engine/types";
import type { Blackout, Draft, Plan } from "./emit";
import {
  DELAY,
  DUPLICATE_GAP_S,
  DUPLICATE_PROB,
  FUZZ_EVENTS,
  ORPHAN_RETRACTION_SHARE,
  ORPHAN_TARGET_EXTRA_DELAY_S,
  RETRACTION_AFTER_S,
  RETRACTION_PROB,
} from "./params";
import { rngFor, stableId } from "./rng";
import type { EventTruth } from "./truth";

export interface Delivered {
  events: Event[];
  truths: Record<string, EventTruth>;
}

function blackoutFor(blackouts: Blackout[], d: Draft): Blackout | undefined {
  if (d.source.source_type === "gateway") return undefined; // the monitor itself is never blacked out
  return blackouts.find(
    (b) =>
      d.true_t >= b.from &&
      d.true_t < b.to &&
      ((b.gateway_id !== undefined && d.source.gateway_id === b.gateway_id) ||
        (b.source_type !== undefined && d.source.source_type === b.source_type)),
  );
}

// Build an Event with a fixed key order (so JSON output is byte-stable) and no hidden fields.
function toEvent(d: Draft, id: string, occurred_at: number, arrived_at: number, retracts?: string): Event {
  const e: Event = {
    id,
    source_id: d.source.source_id,
    source_type: d.source.source_type,
    zone_id: d.zone_id,
    kind: retracts ? "retraction" : d.kind,
    occurred_at,
    arrived_at,
  };
  if (d.source.gateway_id !== undefined) e.gateway_id = d.source.gateway_id;
  if (!retracts && d.value !== undefined) e.value = d.value;
  if (!retracts && d.severity !== undefined) e.reported_severity = d.severity;
  if (retracts) e.retracts = retracts;
  if (!retracts && d.text !== undefined) e.text = d.text;
  if (!retracts && d.narrative_id !== undefined) e.narrative_id = d.narrative_id;
  return e;
}

export function deliver(seed: number, plan: Plan, drafts: Draft[], opts: { fuzz?: boolean } = {}): Delivered {
  const events: Event[] = [];
  const truths: Record<string, EventTruth> = {};
  for (const d of drafts) {
    const rng = rngFor(seed, `dl:${d.key}`);
    // Draw every number up front, in a fixed order, so the stream is easy to reason about.
    const n = rng.normal(0, DELAY.spread);
    const isLate = rng.chance(DELAY.late_prob);
    const lateExtra = rng.range(DELAY.late_extra_s[0], DELAY.late_extra_s[1]);
    const isDup = rng.chance(DUPLICATE_PROB);
    const dupGap = rng.range(DUPLICATE_GAP_S[0], DUPLICATE_GAP_S[1]);
    const isRetracted = rng.chance(RETRACTION_PROB);
    const retractAfter = rng.range(RETRACTION_AFTER_S[0], RETRACTION_AFTER_S[1]);
    const isOrphan = rng.chance(ORPHAN_RETRACTION_SHARE);
    const orphanExtra = rng.range(ORPHAN_TARGET_EXTRA_DELAY_S[0], ORPHAN_TARGET_EXTRA_DELAY_S[1]);
    const retractDelay = rng.range(5, 30);
    const backlogJitter = rng.range(0, DELAY.backlog_spread_s);

    // Log-normal delay around the source's nominal latency, clamped to 5..90 s.
    let delay = Math.min(DELAY.max_s, Math.max(DELAY.min_s, d.source.nominal_latency_s * Math.exp(n)));
    if (isLate) delay += lateExtra;

    const retract = d.can_mess && isRetracted;
    const orphan = retract && isOrphan;
    if (orphan) delay += orphanExtra; // target is held up, its retraction overtakes it

    let arrived = d.true_t + delay;
    const bo = blackoutFor(plan.blackouts, d);
    if (bo) {
      if (!bo.backlog || d.kind === "heartbeat") continue; // lost for good
      arrived = bo.to + backlogJitter; // buffered, dumped when the gateway comes back
    }

    const id = stableId(seed, d.key);
    const occurred = d.true_t + d.source.clock_offset; // skewed source clock
    events.push(toEvent(d, id, Math.round(occurred), Math.round(arrived)));
    const dup = d.can_mess && isDup;
    if (dup) events.push(toEvent(d, id, Math.round(occurred), Math.round(arrived + dupGap)));
    truths[id] = {
      true_occurred_at: d.true_t,
      is_lie: d.is_lie,
      is_mimic: d.is_mimic,
      is_duplicate: d.is_duplicate,
      is_background: d.is_background,
      retransmissions: dup ? 1 : 0,
      retracted: retract,
    };

    if (retract) {
      const issue = d.true_t + (orphan ? retractDelay * 2 : retractAfter);
      const rid = stableId(seed, `${d.key}:r`);
      const r = toEvent(d, rid, Math.round(issue + d.source.clock_offset), Math.round(issue + retractDelay), id);
      if (!blackoutFor(plan.blackouts, { ...d, true_t: Math.round(issue) })) {
        events.push(r);
        truths[rid] = {
          true_occurred_at: Math.round(issue),
          is_lie: false,
          is_mimic: d.is_mimic,
          is_duplicate: false,
          is_background: d.is_background,
          retransmissions: 0,
          retracted: false,
        };
      }
    }
  }

  if (opts.fuzz) events.push(...fuzzEvents(seed, plan));

  // Stream order = arrival order (ties broken by id). Out-of-order relative to
  // occurred_at happens naturally because delays differ.
  events.sort((a, b) => a.arrived_at - b.arrived_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { events, truths };
}

// Malformed events for quarantine tests: NaN value, missing zone, unknown kind,
// timestamp far in the future. They are cast through `unknown` on purpose.
function fuzzEvents(seed: number, plan: Plan): Event[] {
  const rng = rngFor(seed, `${plan.tag}fuzz`);
  const out: Event[] = [];
  for (let i = 0; i < FUZZ_EVENTS; i++) {
    const t = Math.round(rng.range(60, plan.duration - 60));
    const base: Record<string, unknown> = {
      id: stableId(seed, `${plan.tag}fuzz#${i}`),
      source_id: "unknown-src",
      source_type: "traffic_sensor",
      zone_id: "z00",
      kind: "traffic_slowdown",
      occurred_at: t,
      arrived_at: t + 10,
    };
    const flavour = i % 4;
    if (flavour === 0) base.value = Number.NaN;
    if (flavour === 1) delete base.zone_id;
    if (flavour === 2) base.kind = "alien_signal";
    if (flavour === 3) base.occurred_at = t + 86400; // a day in the future
    out.push(base as unknown as Event);
  }
  return out;
}
