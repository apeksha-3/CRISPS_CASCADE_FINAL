// eval/trace.ts
// Look inside single episodes.
//   npx tsx eval/trace.ts --split test --episode test-cascade-5126       tick-by-tick belief and action
//   npx tsx eval/trace.ts --split test --episode test-cascade-5126 --detail 0,5,8,10,12,15
//                                                                        + forecast and explanation at those minutes
//   npx tsx eval/trace.ts --split test --twin test-twin-5200             both twins side by side, prefix check
//   npx tsx eval/trace.ts --split test --group cutout --policy engine    one line per episode in the group(s)
// Single-episode traces use engine-frozen by default (no learning history; pass --policy to change).
// --group matches the start of the group name ("cutout" = cutout:cameras + cutout:gateway).

import { BASE_RATES } from "../config/transitions";
import { ACTIONS, type TickRecord } from "../engine/types";
import { groupOf, loadSplit, type Split } from "../sim/dataset";
import { makePolicy } from "./baselines";
import { runEpisode } from "./run";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const split = (arg("split") ?? "test") as Split;
const policy = makePolicy(arg("policy") ?? "engine-frozen");
const eps = loadSplit(split);
const p = (x: number) => x.toFixed(3);
const lvl = (r: TickRecord) => ACTIONS.indexOf(r.action);
const peak = (rs: TickRecord[], h: keyof TickRecord["probabilities"]) => p(Math.max(...rs.map((r) => r.probabilities[h])));

function detail(r: TickRecord | undefined, minute: number): string[] {
  if (!r) {
    const b = BASE_RATES;
    return [`min ${minute}: prior N ${p(b.NOISE)} S ${p(b.SENSOR_FAILURE)} I ${p(b.ISOLATED_INCIDENT)} C ${p(b.CASCADING_CRISIS)}  (no tick yet: the belief before any evidence)`];
  }
  const pr = r.probabilities;
  const L = [`min ${minute}: N ${p(pr.NOISE)} S ${p(pr.SENSOR_FAILURE)} I ${p(pr.ISOLATED_INCIDENT)} C ${p(pr.CASCADING_CRISIS)}  action ${r.action}  units ${r.evidence_units} (clusters ${r.clusters})`];
  const fc = r.forecast.map((f) => `${f.kind} [${(f.window_p10 / 60).toFixed(1)}, ${(f.window_p90 / 60).toFixed(1)}] min p=${f.probability.toFixed(2)}`);
  L.push(`   forecast: ${fc.length ? fc.join(" | ") : "(none)"}`);
  for (const e of r.explanation.top_evidence) L.push(`   top: ${e.llr >= 0 ? "+" : ""}${e.llr.toFixed(2)} ${e.description} -> supports ${e.supports}`);
  L.push(`   why: ${r.explanation.delta_summary}`);
  L.push(`   next: ${r.explanation.forecast_summary}`);
  return L;
}

const twin = arg("twin");
const id = arg("episode");
if (twin) {
  const a = eps.find((e) => e.episode_id === `${twin}-A`);
  const b = eps.find((e) => e.episode_id === `${twin}-B`);
  if (!a || !b) throw new Error(`no twin pair ${twin} in ${split}`);
  const split_t = a.truth.split_time!;
  const ra = runEpisode(policy, a).records;
  const rb = runEpisode(policy, b).records;
  console.log(`twin pair ${twin}: A truth ${a.truth.hypothesis}, B truth ${b.truth.hypothesis}, split at min ${split_t / 60}`);
  console.log(" min | A: P(N)  P(S)  P(I)  P(C)  action  | B: P(N)  P(S)  P(I)  P(C)  action  | same?");
  const row = (r: TickRecord) => `${p(r.probabilities.NOISE)} ${p(r.probabilities.SENSOR_FAILURE)} ${p(r.probabilities.ISOLATED_INCIDENT)} ${p(r.probabilities.CASCADING_CRISIS)} ${r.action.padEnd(8)}`;
  const end = Math.min(ra.length, rb.length, split_t / 60 + 12);
  for (let i = 0; i < end; i++) {
    const same = JSON.stringify([ra[i].probabilities, ra[i].action]) === JSON.stringify([rb[i].probabilities, rb[i].action]);
    console.log(`${String(ra[i].tick_time / 60).padStart(4)} | ${row(ra[i])} | ${row(rb[i])} | ${same ? "identical" : "DIFFERENT"}${ra[i].tick_time === split_t ? "   <- split" : ""}`);
  }
  for (const m of [split_t / 60 + 3, split_t / 60 + 6, split_t / 60 + 10]) {
    console.log(`\n-- minute ${m} --`);
    console.log("A (cascade twin):");
    for (const l of detail(ra[m - 1], m)) console.log("  " + l);
    console.log("B (benign twin):");
    for (const l of detail(rb[m - 1], m)) console.log("  " + l);
  }
} else if (id) {
  const ep = eps.find((e) => e.episode_id === id);
  if (!ep) throw new Error(`no episode ${id} in ${split}`);
  const t = ep.truth;
  console.log(`${id}  group ${groupOf(ep)}  truth ${t.hypothesis}  onset ${t.onset !== undefined ? (t.onset / 60).toFixed(1) : "-"} min  critical ${t.critical_time !== undefined ? (t.critical_time / 60).toFixed(1) : "-"} min`);
  const stages = Object.entries(t.stage_times).map(([k, s]) => `${k} ${((s as number) / 60).toFixed(1)}`).join(", ");
  console.log(`first stage starts (min): ${stages || "-"}`);
  console.log(" min  P(NOISE) P(SENS)  P(ISO)   P(CASC)  action    E[cost]  coverage flags");
  const { records } = runEpisode(policy, ep);
  const minutes = arg("detail");
  if (minutes) {
    for (const m of minutes.split(",").map(Number)) for (const l of detail(records.find((r) => r.tick_time === m * 60), m)) console.log(l);
    process.exit(0);
  }
  const b = BASE_RATES;
  console.log(`   0  ${p(b.NOISE)}    ${p(b.SENSOR_FAILURE)}    ${p(b.ISOLATED_INCIDENT)}    ${p(b.CASCADING_CRISIS)}    (prior: the belief before the first tick)`);
  for (const r of records) {
    const flags = [r.degraded ? "DEGRADED" : "", r.fallback ? "FALLBACK" : ""].join(" ").trim();
    const pr = r.probabilities;
    console.log(
      `${String(r.tick_time / 60).padStart(4)}  ${p(pr.NOISE)}    ${p(pr.SENSOR_FAILURE)}    ${p(pr.ISOLATED_INCIDENT)}    ${p(pr.CASCADING_CRISIS)}    ${r.action.padEnd(9)} ${Number.isFinite(r.expected_cost) ? r.expected_cost.toFixed(2).padStart(6) : "     -"}   ${r.source_summary.coverage.toFixed(2)}    ${flags}`,
    );
  }
} else {
  const g = arg("group") ?? "cutout";
  console.log(`policy ${policy.name}, split ${split}, groups starting with "${g}"`);
  console.log(`${"episode".padEnd(28)} ${"group".padEnd(20)} ${"base".padEnd(18)} ${"truth".padEnd(18)} ${"max action".padEnd(10)} first ALERT+  ESCALATE ticks  degraded ticks  fallback  peak P(S)  peak P(I)  peak P(C)  Brier`);
  for (const ep of eps.filter((e) => groupOf(e).startsWith(g))) {
    const { records, result } = runEpisode(policy, ep);
    const max = ACTIONS[Math.max(...records.map(lvl))];
    const firstAlert = records.find((r) => lvl(r) >= 2);
    console.log(
      `${ep.episode_id.padEnd(28)} ${groupOf(ep).padEnd(20)} ${(ep.truth.base_type ?? "-").padEnd(18)} ${ep.truth.hypothesis.padEnd(18)} ${max.padEnd(10)} ${(firstAlert ? `min ${firstAlert.tick_time / 60}` : "-").padEnd(12)}  ${String(records.filter((r) => r.action === "ESCALATE").length).padStart(14)}  ${String(records.filter((r) => r.degraded).length).padStart(14)}  ${String(records.filter((r) => r.fallback).length).padStart(8)}  ${peak(records, "SENSOR_FAILURE").padStart(9)}  ${peak(records, "ISOLATED_INCIDENT").padStart(9)}  ${peak(records, "CASCADING_CRISIS").padStart(9)}  ${result.brier.toFixed(3)}`,
    );
  }
}
