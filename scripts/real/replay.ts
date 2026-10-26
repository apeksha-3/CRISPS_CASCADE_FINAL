// scripts/real/replay.ts
// Phase 8 step E: replay the real split BY EVENT, with no number computed by learning from the event it is scored on.
//
//   --split <dir under data/episodes>   default real
//   --policies engine,engine-frozen,count-threshold,always-watch
//   --mode loeo | harness               default loeo
//
//   loeo     leave-one-event-out: for each event E, a fresh policy first learns (trust only, as in the harness)
//            from every OTHER event's episodes, then plays E's episodes with learning switched off.
//            Nothing about E reaches the policy before E is scored. Episodes of E are not used to learn from each other.
//   harness  the way `npm run eval -- --split real` plays them: one shuffled sequence, learning between episodes.
//            An episode can learn from another episode cut from the SAME event, so it flatters the engine. Shown for comparison.
//
// The engine, its config and the eval code are used as they are. Nothing is tuned here.
//
// Run: npx tsx scripts/real/replay.ts --split real --policies engine,engine-frozen,count-threshold,always-watch

import { writeFileSync } from "node:fs";
import { makePolicy } from "../../eval/baselines";
import { groupBy, summarize } from "../../eval/report";
import { eventLabels, type EpisodeResult, evalOrder, runEpisode } from "../../eval/run";
import { classOf, eventOf } from "../../real/events";
import { loeoFolds } from "../../real/loeo";
import { loadSplit } from "../../sim/dataset";
import type { Episode } from "../../sim/truth";
import type { TickRecord } from "../../engine/types";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const split = arg("split", "real");
const names = arg("policies", "engine,engine-frozen,count-threshold,always-watch").split(",");
const mode = arg("mode", "loeo");
const episodes = evalOrder(split as never, loadSplit(split as never));

interface Row {
  ep: Episode;
  result: EpisodeResult;
  pS: number; // mean P(sensor_failure) over the ticks
  pC: number; // mean P(cascade)
  maxC: number;
  actions: string; // action runs in episode minutes
}

function runs(records: TickRecord[]): string {
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i <= records.length; i++)
    if (i === records.length || records[i].action !== records[start].action) {
      out.push(`${records[start].action[0]}${records[start].tick_time / 60}-${records[i - 1].tick_time / 60}`);
      start = i;
    }
  return out.join(" ");
}

function play(policyName: string, ep: Episode, policy: ReturnType<typeof makePolicy>): Row {
  const { records, result } = runEpisode(policy, ep);
  const m = (f: (r: TickRecord) => number) => records.reduce((s, r) => s + f(r), 0) / records.length;
  return { ep, result, pS: m((r) => r.probabilities.SENSOR_FAILURE), pC: m((r) => r.probabilities.CASCADING_CRISIS), maxC: Math.max(...records.map((r) => r.probabilities.CASCADING_CRISIS)), actions: runs(records) };
}

function runPolicy(name: string): Row[] {
  if (mode === "harness") {
    const policy = makePolicy(name, split as never);
    return episodes.map((ep) => {
      const row = play(name, ep, policy);
      policy.afterEpisode?.(ep.truth.hypothesis, eventLabels(ep));
      return row;
    });
  }
  const rows: Row[] = [];
  for (const fold of loeoFolds(episodes, eventOf)) {
    const policy = makePolicy(name, split as never);
    for (const ep of fold.train) {
      runEpisode(policy, ep);
      policy.afterEpisode?.(ep.truth.hypothesis, eventLabels(ep));
    }
    for (const ep of fold.test) rows.push(play(name, ep, policy)); // the held-out event is scored, never learned from
  }
  return rows;
}

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "-");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const ambiguousSplit = episodes.every((e) => (e.truth.hypothesis as string) === "UNLABELLED");
const all: Record<string, Row[]> = {};
console.log(`split ${split}, ${episodes.length} episodes, ${new Set(episodes.map(eventOf)).size} events, mode ${mode}\n`);
if (!ambiguousSplit) console.log(`${"policy".padEnd(16)} ${"Brier".padStart(6)} ${"LogLoss".padStart(7)} ${"Cost/tick".padStart(9)} ${"FalseAlarm".padStart(10)} ${"cascade ALERT+".padStart(15)} ${"meanP(S)".padStart(9)} ${"meanP(C) casc".padStart(14)} ${"maxP(C) casc".padStart(13)}`);
for (const name of names) {
  const rows = runPolicy(name);
  all[name] = rows;
  if (ambiguousSplit) continue;
  const s = summarize(rows.map((r) => r.result));
  const cas = rows.filter((r) => r.ep.truth.hypothesis === "CASCADING_CRISIS");
  console.log(`${name.padEnd(16)} ${f(s.brier).padStart(6)} ${f(s.log_loss).padStart(7)} ${f(s.cost_per_tick, 2).padStart(9)} ${pct(s.false_alarm_rate).padStart(10)} ${`${cas.filter((r) => r.result.any_alert).length}/${cas.length}`.padStart(15)} ${f(mean(rows.map((r) => r.pS))).padStart(9)} ${f(mean(cas.map((r) => r.pC))).padStart(14)} ${f(mean(cas.map((r) => r.maxC))).padStart(13)}`);
}

if (ambiguousSplit) {
  console.log("AMBIGUOUS events: a flash flood warning named NYC counties, but no cited cascade-class impact. Not scored (no Brier, no false alarm, no lead time): only what each policy DID.");
  console.log(`${"event".padEnd(18)} ${names.map((n) => n.padEnd(36)).join(" ")}`);
  for (const e of [...new Set(episodes.map(eventOf))].sort())
    console.log(`${e.padEnd(18)} ${names.map((n) => { const rs = all[n].filter((r) => eventOf(r.ep) === e); const top = ["WATCH", "PREPARE", "ALERT", "ESCALATE"][Math.max(...rs.map((r) => ["WATCH", "PREPARE", "ALERT", "ESCALATE"].indexOf(r.result.max_action)))]; return `${top.padEnd(8)} ALERT+ ${rs.filter((r) => r.result.any_alert).length}/${rs.length}  max P(C) ${f(Math.max(...rs.map((r) => r.maxC)), 2)}  P(S) ${f(mean(rs.map((r) => r.pS)), 2)}`.padEnd(36); }).join(" ")}`);
  process.exit(0);
}
console.log("\nPer class (episodes in the class, independent events in brackets)");
for (const name of names) {
  console.log(`  ${name}`);
  const rows = all[name];
  for (const cls of [...new Set(rows.map((r) => classOf(r.ep)))].sort()) {
    const rs = rows.filter((r) => classOf(r.ep) === cls);
    const ev = new Set(rs.map((r) => eventOf(r.ep))).size;
    const flag = ev < 5 ? "   <- fewer than 5 independent events: not statistically meaningful" : "";
    console.log(`    ${cls.padEnd(10)} ${String(rs.length).padStart(3)} episodes [${String(ev).padStart(2)} events]  Brier ${f(mean(rs.map((r) => r.result.brier)))}  ALERT+ ${pct(rs.filter((r) => r.result.any_alert).length / rs.length)}  mean P(S) ${f(mean(rs.map((r) => r.pS)))}${flag}`);
  }
}
for (const cls of ["SENSOR_FAILURE", "ISOLATED_INCIDENT"]) if (!episodes.some((e) => e.truth.hypothesis === cls)) console.log(`    ${cls}: 0 episodes, 0 events (empty class)`);

console.log("\nPer event, cascade events only (policy: Brier / max action / ALERT+ episodes / mean P(S) / max P(C))");
const casEvents = [...new Set(episodes.filter((e) => e.truth.hypothesis === "CASCADING_CRISIS").map(eventOf))].sort();
console.log(`${"event".padEnd(22)} ${names.map((n) => n.padEnd(34)).join(" ")}`);
for (const e of casEvents)
  console.log(
    `${e.padEnd(22)} ${names
      .map((n) => {
        const rs = all[n].filter((r) => eventOf(r.ep) === e);
        const top = ["WATCH", "PREPARE", "ALERT", "ESCALATE"][Math.max(...rs.map((r) => ["WATCH", "PREPARE", "ALERT", "ESCALATE"].indexOf(r.result.max_action)))];
        return `${f(mean(rs.map((r) => r.result.brier)), 2)} ${top.padEnd(8)} ${rs.filter((r) => r.result.any_alert).length}/${rs.length} S${f(mean(rs.map((r) => r.pS)), 2)} C${f(Math.max(...rs.map((r) => r.maxC)), 2)}`.padEnd(34);
      })
      .join(" ")}`,
  );

if (process.argv.includes("--actions")) {
  console.log("\nCascade episodes, actions by episode minute (W/P/A/E start-end)");
  for (const n of names) {
    console.log(`  ${n}`);
    for (const r of all[n].filter((x) => x.ep.truth.hypothesis === "CASCADING_CRISIS")) console.log(`    ${r.ep.episode_id.padEnd(30)} ${r.actions}   max P(C) ${f(r.maxC)}`);
  }
}
void groupBy;
writeFileSync(`data/real/replay-${split}-${mode}.json`, JSON.stringify(Object.fromEntries(names.map((n) => [n, all[n].map((r) => ({ id: r.ep.episode_id, event: eventOf(r.ep), cls: classOf(r.ep), brier: r.result.brier, cost: r.result.cost_per_tick, max_action: r.result.max_action, any_alert: r.result.any_alert, pS: r.pS, pC: r.pC, maxC: r.maxC, actions: r.actions }))])), null, 1));
