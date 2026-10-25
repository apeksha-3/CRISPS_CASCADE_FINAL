// eval/harness.ts
// `npm run eval -- --split dev|test|prior-shift --policy <name>|engine|all`
// Runs the policy tick by tick over every episode of the split, IN ORDER
// (eval/run.ts evalOrder): learning policies are told each episode's truth after
// it ends (engine/learn.ts) and start the next one with the updated trust + prior.
// Prints the summary table and saves it to data/eval-results.json (merged by split/policy).
//   --policy engine on dev/test:  also runs always-watch, count-threshold and
//       engine-handset on the same episodes and prints the comparison, the
//       trust panel, the learned prior and the dev/test agreement (if both splits ran)
//   --policy engine on prior-shift: engine vs engine-static-prior vs count-threshold,
//       halves before/after the regime change, the prior over time, CUSUM alarms
// Only /eval and /sim may read ground truth.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankTrust } from "../engine/trust";
import { loadSplit, type Split } from "../sim/dataset";
import { PRIOR_SHIFT } from "../sim/params";
import { EXTRA_POLICIES, makePolicy, type Policy, POLICIES } from "./baselines";
import { formatComparison, formatPrior, formatReport, formatShift, formatTrustPanel, groupBy, summarize, type Summary } from "./report";
import { type EpisodeResult, evalOrder, runSequence } from "./run";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function main(): void {
  const split = arg("split", "test") as Split;
  const policyName = arg("policy", "count-threshold");
  const episodes = evalOrder(split, loadSplit(split));
  const outFile = join(process.cwd(), "data", "eval-results.json");
  const saved: Record<string, unknown> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};

  const summaries: Record<string, Summary> = {};
  const results: Record<string, EpisodeResult[]> = {};
  const policies: Record<string, Policy> = {};
  const run = (name: string) => {
    const policy = makePolicy(name, split);
    const rs = runSequence(policy, episodes);
    const summary = summarize(rs);
    const groups = groupBy(rs);
    summaries[name] = summary;
    results[name] = rs;
    policies[name] = policy;
    saved[`${split}/${name}`] = { summary, groups: Object.fromEntries(groups.map(([g, x]) => [g, summarize(x)])), episodes: rs };
    return { summary, groups };
  };

  const names = policyName === "all" ? [...Object.keys(POLICIES), ...Object.keys(EXTRA_POLICIES)] : [policyName];
  for (const name of names) {
    const { summary, groups } = run(name);
    console.log(formatReport(name, split, summary, groups));
    console.log("");
  }

  if (names.includes("engine") && split === "prior-shift") {
    for (const name of ["engine-static-prior", "count-threshold"]) if (!summaries[name]) run(name);
    const order = ["engine", "engine-static-prior", "count-threshold"];
    console.log(formatShift(order.map((n) => [n, results[n]] as [string, EpisodeResult[]]), PRIOR_SHIFT.shift_at));
    console.log("");
    const rs = results.engine;
    const cascades = (a: number, b: number) => rs.slice(a, b).filter((r) => r.hypothesis === "CASCADING_CRISIS").length;
    console.log(`true cascade share: episodes 1-50 ${pct(cascades(0, 50) / 50)}, 51-100 ${pct(cascades(50, 100) / 50)}`);
    console.log("learned prior the engine STARTED each episode with:");
    for (const n of [1, 25, 50, 55, 60, 65, 75, 100]) console.log(`  episode ${String(n).padStart(3)}: ${formatPrior(rs[n - 1].prior)}   (truth ${rs[n - 1].hypothesis})`);
    const learned = policies.engine.learned!();
    console.log(`CUSUM alarms at episode(s): ${learned.drift.alarms.length ? learned.drift.alarms.join(", ") : "none"}`);
    for (const l of learned.log) console.log(`  ${l}`);
    console.log("");
  } else if (names.includes("engine")) {
    for (const name of Object.keys(POLICIES)) if (!summaries[name]) run(name);
    console.log(formatComparison(split, Object.keys(POLICIES).map((n) => [n, summaries[n]] as [string, Summary])));
    console.log("");
    const learned = policies.engine.learned!();
    console.log(formatTrustPanel(rankTrust(learned.trust)));
    console.log("");
    console.log(`learned prior after all ${episodes.length} episodes: ${formatPrior(policies.engine.basePrior!())}`);
    console.log(`CUSUM alarms at episode(s): ${learned.drift.alarms.length ? learned.drift.alarms.join(", ") : "none"}`);
    console.log("");
    const other = split === "dev" ? "test" : "dev";
    const o = (saved[`${other}/engine`] as { summary: Summary } | undefined)?.summary;
    if (o) {
      const e = summaries.engine;
      const [dev, test] = split === "dev" ? [e, o] : [o, e];
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-9, Math.min(a, b));
      console.log("Dev/test agreement (engine)");
      console.log(`  ${"".padEnd(12)} ${"dev".padStart(8)} ${"test".padStart(8)}  relative gap`);
      const flag = (r: number) => (r > 0.3 ? "  <- more than 30%: possible overfitting" : "");
      console.log(`  ${"Brier".padEnd(12)} ${dev.brier.toFixed(3).padStart(8)} ${test.brier.toFixed(3).padStart(8)}  ${pct(rel(dev.brier, test.brier))}${flag(rel(dev.brier, test.brier))}`);
      console.log(`  ${"False alarm".padEnd(12)} ${pct(dev.false_alarm_rate).padStart(8)} ${pct(test.false_alarm_rate).padStart(8)}  ${pct(rel(dev.false_alarm_rate, test.false_alarm_rate))}${flag(rel(dev.false_alarm_rate, test.false_alarm_rate))}`);
      console.log(`  ${"Cost/tick".padEnd(12)} ${dev.cost_per_tick.toFixed(2).padStart(8)} ${test.cost_per_tick.toFixed(2).padStart(8)}  ${pct(rel(dev.cost_per_tick, test.cost_per_tick))}`);
      console.log("");
    }
  }
  // sorted keys so the file is byte-identical for identical runs
  const ordered = Object.fromEntries(Object.keys(saved).sort().map((k) => [k, saved[k]]));
  writeFileSync(outFile, JSON.stringify(ordered, null, 1));
  console.log(`saved ${outFile}`);
}

main();
