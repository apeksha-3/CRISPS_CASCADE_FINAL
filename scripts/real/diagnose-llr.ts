// scripts/real/diagnose-llr.ts
// Phase 9 step A. Where does the engine's cascade signal come from?
// For each event kind, the log-likelihood (nats) that the engine's evidence units add to each hypothesis at the END of an
// episode, summed over units and averaged per episode: real Ida (3 episodes) against the simulator's cascades (the 40 `cascade`
// episodes of the test split). "C - N" is the evidence for CASCADE over NOISE. A table only: read-only use of Engine.units().
// Run: npx tsx scripts/real/diagnose-llr.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../engine/tick";
import type { Event, EventKind } from "../../engine/types";
import type { Episode } from "../../sim/truth";

const KINDS: EventKind[] = ["rain_heavy", "drainage_anomaly", "citizen_report", "traffic_slowdown", "emergency_call_spike", "hospital_arrivals_unusual", "power_comms_load", "gateway_heartbeat_lost"];
const LATE = new Set<EventKind>(["hospital_arrivals_unusual", "power_comms_load", "emergency_call_spike"]);

interface Acc { units: number; n: number; N: number; S: number; I: number; C: number }
const zero = (): Acc => ({ units: 0, n: 0, N: 0, S: 0, I: 0, C: 0 });

function run(ep: Episode, acc: Map<EventKind, Acc>): void {
  const engine = new Engine(ep.registry);
  const ev = ep.events.slice().sort((a: Event, b: Event) => a.arrived_at - b.arrived_at);
  let cut = 0;
  for (let t = 60; t <= ep.duration; t += 60) {
    const prev = cut;
    while (cut < ev.length && ev[cut].arrived_at <= t) cut++;
    engine.tick(ev.slice(prev, cut), t);
  }
  for (const u of engine.units()) {
    const a = acc.get(u.kind) ?? zero();
    a.units++;
    a.n += u.n;
    a.N += u.hypothesis_contributions.NOISE;
    a.S += u.hypothesis_contributions.SENSOR_FAILURE;
    a.I += u.hypothesis_contributions.ISOLATED_INCIDENT;
    a.C += u.hypothesis_contributions.CASCADING_CRISIS;
    acc.set(u.kind, a);
  }
}

function load(dir: string, keep: (e: Episode) => boolean): Episode[] {
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Episode).filter(keep);
}

function table(title: string, eps: Episode[]): { early: number; late: number } {
  const acc = new Map<EventKind, Acc>();
  for (const ep of eps) run(ep, acc);
  const n = eps.length;
  console.log(`\n${title}  (${n} episodes, values per episode)`);
  console.log(`${"kind".padEnd(28)} ${"units".padStart(6)} ${"events".padStart(7)} ${"NOISE".padStart(7)} ${"SENSOR".padStart(7)} ${"ISOL".padStart(7)} ${"CASC".padStart(7)} ${"C - N".padStart(7)}`);
  let early = 0;
  let late = 0;
  for (const k of KINDS) {
    const a = acc.get(k);
    if (!a) continue;
    const cn = (a.C - a.N) / n;
    if (cn > 0) (LATE.has(k) ? (late += cn) : (early += cn));
    console.log(`${(LATE.has(k) ? k + " *" : k).padEnd(28)} ${(a.units / n).toFixed(1).padStart(6)} ${(a.n / n).toFixed(1).padStart(7)} ${(a.N / n).toFixed(2).padStart(7)} ${(a.S / n).toFixed(2).padStart(7)} ${(a.I / n).toFixed(2).padStart(7)} ${(a.C / n).toFixed(2).padStart(7)} ${cn.toFixed(2).padStart(7)}`);
  }
  console.log(`positive C-N from early kinds (rain, drainage, traffic, citizens): ${early.toFixed(2)}; from late kinds (* calls, hospital, power): ${late.toFixed(2)}; late share ${(100 * late / Math.max(1e-9, early + late)).toFixed(0)}%`);
  return { early, late };
}

const ida = load(join(process.cwd(), "data", "episodes", "real"), (e) => e.episode_id.startsWith("real-ida-2021"));
const sim = load(join(process.cwd(), "data", "episodes", "test"), (e) => e.type === "cascade");
const a = table("REAL Ida 2021", ida);
const b = table("SIMULATOR cascades (test split)", sim);
console.log(`\nVerdict: late-stage evidence provides ${(100 * b.late / (b.early + b.late)).toFixed(0)}% of the positive cascade-over-noise evidence in the simulator and ${(100 * a.late / Math.max(1e-9, a.early + a.late)).toFixed(0)}% on Ida; total positive C-N is ${(b.early + b.late).toFixed(2)} nats per simulator cascade against ${(a.early + a.late).toFixed(2)} on Ida.`);
