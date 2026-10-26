// server/simple.ts
// The plain-language view of a rules-engine tick (Layers 1 and 2 of the dashboard). It only READS the tick and the engine's
// public evidence units; it changes nothing in the engine. No probability vectors, log-likelihoods or Brier scores reach this view.
//
//   headline / sentence / what to do   from the recommended action and the strongest evidence
//   confidence bar                     from the engine's calibration on the simulator test split (ECE of P(cascade), ml/engine-calibration.json),
//                                      halved while the engine is DEGRADED (many sensors silent). Not from Brier.
//   zone grid                          per zone, how much strong recent evidence there is (see zoneSeverity)
//   what's happening / expected        the last 5 minutes of events and the engine's forecast, in words

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confidenceBar, confidenceWord } from "../ml/gate";
import type { Action, EventKind } from "../engine/types";
import type { Engine } from "../engine/tick";
import type { FeedEvent, TickPayload } from "./runner";

const engineCal = JSON.parse(readFileSync(join(process.cwd(), "ml", "engine-calibration.json"), "utf8")) as { ece: number; ticks: number; episodes: number };

export const PLAIN_KIND: Record<EventKind, string> = {
  rain_heavy: "heavy rain",
  drainage_anomaly: "drainage problems",
  traffic_slowdown: "road slowdowns",
  emergency_call_spike: "more emergency calls than usual",
  hospital_arrivals_unusual: "unusual hospital arrivals",
  power_comms_load: "strain on power or phone networks",
  citizen_report: "citizen reports",
  heartbeat: "sensor check-ins",
  gateway_heartbeat_lost: "a sensor hub gone silent",
  retraction: "withdrawn reports",
};

export const STATUS_WORDS: Record<Action, { label: string; line: string; todo: string }> = {
  WATCH: { label: "Watch", line: "Nothing unusual", todo: "Keep normal monitoring." },
  PREPARE: { label: "Prepare", line: "Something may be developing", todo: "Check that crews and pumps are ready and look at the zones marked on the grid." },
  ALERT: { label: "Alert", line: "A crisis is likely developing", todo: "Alert the flood response team and warn the zones marked on the grid." },
  ESCALATE: { label: "Escalate", line: "A crisis is under way", todo: "Escalate to the city emergency lead now and open the response plan." },
};

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export interface SimpleView {
  status: Action;
  label: string;
  line: string;
  sentence: string;
  what_to_do: string;
  confidence: { bar: number; word: string; note: string };
  zones: { zone_id: string; name: string; severity: 0 | 1 | 2 | 3; expected: boolean }[];
  threat: number; // 0 to 3, the action level
  happening: string;
  expected: string;
  rumor: string | null;
  degraded: boolean;
}

// Per zone: add up the weight of strong evidence units whose newest member is under 10 minutes old.
// 0 = quiet, 1 = a little (weight under 2), 2 = some (under 5), 3 = a lot. A display heuristic, not a probability.
export function zoneSeverity(w: number): 0 | 1 | 2 | 3 {
  return w <= 0 ? 0 : w < 2 ? 1 : w < 5 ? 2 : 3;
}

export class SimpleBuilder {
  private recent: FeedEvent[][] = [];
  constructor(private readonly registry: { zones: { zone_id: string; name: string }[] }) {}

  view(p: TickPayload, engine: Engine): SimpleView {
    const r = p.record;
    const now = r.tick_time;
    const name = (z: string) => this.registry.zones.find((x) => x.zone_id === z)?.name ?? z;
    this.recent.push(p.events.filter((e) => e.kind !== "retraction" && !e.dup && !e.quarantined));
    if (this.recent.length > 5) this.recent.shift();

    // zones
    const weight = new Map<string, number>();
    const rumor: string[] = [];
    for (const u of engine.units()) {
      if (u.n <= 0 || now - u.last_t > 600) continue;
      if (u.unit_type === "narrative" && !u.corroborated && u.n >= 5) rumor.push(`${u.n} citizen reports in ${name(u.zone_id)} tell the same story, but no sensor confirms it. They are counted as one report.`);
      if (u.strong && u.kind !== "heartbeat" && u.unit_type !== "narrative") weight.set(u.zone_id, (weight.get(u.zone_id) ?? 0) + u.weight);
    }
    const forecastZones = new Set(r.forecast.flatMap((f) => f.zones));
    const zones = this.registry.zones.map((z) => ({ zone_id: z.zone_id, name: z.name, severity: zoneSeverity(weight.get(z.zone_id) ?? 0), expected: forecastZones.has(z.zone_id) }));

    // sentence: the strongest evidence in words
    const w = STATUS_WORDS[r.action];
    const top = r.explanation.top_evidence[0];
    let sentence = "No unusual pattern in the sensors and reports.";
    if (r.action !== "WATCH" && top) {
      const hot = zones.filter((z) => z.severity >= 2).map((z) => z.name);
      sentence = `The strongest sign is ${PLAIN_KIND[top.kind as EventKind] ?? top.kind} in ${name(top.zone_id ?? "")}${hot.length > 1 ? `; ${list(hot.filter((h) => h !== name(top.zone_id ?? "")))} also show activity` : ""}.`;
    } else if (r.action === "WATCH" && top && top.llr > 0.3) {
      sentence = "A few signs are appearing but they do not yet form a pattern.";
    }

    // what's happening: the last 5 minutes
    const counts = new Map<string, number>();
    for (const batch of this.recent) for (const e of batch) counts.set(`${e.kind}|${e.zone_id}`, (counts.get(`${e.kind}|${e.zone_id}`) ?? 0) + 1);
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => { const [kind, zone] = k.split("|"); return `${n} ${PLAIN_KIND[kind as EventKind] ?? kind} in ${name(zone)}`; });
    const happening = groups.length ? `In the last 5 minutes: ${list(groups)}.` : "No new warnings in the last 5 minutes.";

    // what's expected: the engine's forecast
    const minute = (s: number) => Math.round(s / 60);
    const expected = r.forecast.length
      ? `Next likely: ${list(r.forecast.slice(0, 3).map((f) => `${PLAIN_KIND[f.kind]}${f.zones.length ? ` in ${list(f.zones.slice(0, 2).map(name))}` : ""} around minute ${minute(f.window_p10)} to ${minute(f.window_p90)}`))}.`
      : "No further stages are forecast yet.";

    // confidence: how honest the engine's probabilities were on the simulator test split, halved while sensors are going silent
    const base = confidenceBar(engineCal.ece);
    const bar = r.degraded ? base * 0.5 : base;
    const pts = Math.round(100 * engineCal.ece);
    const note = `Based on ${engineCal.episodes} simulated test episodes, where this engine's forecasts were off by about ${pts} percentage points on average.${r.degraded ? " Many sensors are silent right now, so it is less sure." : ""}`;

    return { status: r.action, label: w.label, line: w.line, sentence, what_to_do: w.todo, confidence: { bar, word: confidenceWord(bar), note }, zones, threat: ["WATCH", "PREPARE", "ALERT", "ESCALATE"].indexOf(r.action), happening, expected, rumor: rumor.length ? rumor[0] : null, degraded: r.degraded };
  }
}
