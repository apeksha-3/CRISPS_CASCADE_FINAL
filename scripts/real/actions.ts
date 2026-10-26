// scripts/real/actions.ts
// Phase 7 step F, per-episode view: replay the real split with a policy EXACTLY as the harness does
// (same order, same between-episode learning) and print what it DID in every real CASCADE episode.
// It only reads eval/ and the episode files; it changes no scoring.
//
// Run: npx tsx scripts/real/actions.ts [engine|count-threshold|always-watch] [--all]

import { makePolicy } from "../../eval/baselines";
import { eventLabels, evalOrder, runEpisode } from "../../eval/run";
import { loadSplit } from "../../sim/dataset";
import type { TickRecord } from "../../engine/types";

const policyName = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "engine";
const all = process.argv.includes("--all");
const policy = makePolicy(policyName, "real" as never);
const episodes = evalOrder("real" as never, loadSplit("real" as never));

const clock = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}`;

// "WATCH 1-12, PREPARE 13-20, ..." in episode minutes
function runs(records: TickRecord[]): string {
  const out: string[] = [];
  let start = 0;
  for (let i = 1; i <= records.length; i++) {
    if (i === records.length || records[i].action !== records[start].action) {
      out.push(`${records[start].action} min ${records[start].tick_time / 60}-${records[i - 1].tick_time / 60}`);
      start = i;
    }
  }
  return out.join(", ");
}

console.log(`policy ${policyName}, real split, ${episodes.length} episodes in harness order`);
for (const ep of episodes) {
  const { records, result } = runEpisode(policy, ep);
  policy.afterEpisode?.(ep.truth.hypothesis, eventLabels(ep));
  if (!all && ep.truth.hypothesis !== "CASCADING_CRISIS") continue;
  const pc = records.map((r) => r.probabilities.CASCADING_CRISIS);
  const maxP = Math.max(...pc);
  const atMax = records[pc.indexOf(maxP)].tick_time / 60;
  const real = (ep as unknown as { real?: { start_local?: string } }).real;
  console.log(`\n${ep.episode_id}  truth ${ep.truth.hypothesis}  start ${real?.start_local ?? "?"}  onset ${ep.truth.onset === undefined ? "null" : `min ${ep.truth.onset / 60}`}  critical ${ep.truth.critical_time === undefined ? "null" : `min ${ep.truth.critical_time / 60}`}`);
  console.log(`  actions: ${runs(records)}`);
  console.log(`  P(cascade): start ${pc[0].toFixed(3)}, max ${maxP.toFixed(3)} at min ${atMax}, end ${pc[pc.length - 1].toFixed(3)}   Brier ${result.brier.toFixed(3)}   max action ${result.max_action}   lead ${result.lead_min === undefined ? "none (never ALERT+)" : `${result.lead_min.toFixed(1)} min`}`);
  const q = records.reduce((s, r) => s + r.quarantined.length, 0);
  const last = records[records.length - 1];
  console.log(`  evidence units at end ${last.evidence_units}, quarantined ${q}, degraded ticks ${result.degraded_ticks}, sources live/stale/dark at end ${last.source_summary.live}/${last.source_summary.stale}/${last.source_summary.dark}`);
  const spark = pc.filter((_, i) => i % 5 === 4).map((p) => p.toFixed(2)).join(" ");
  console.log(`  P(cascade) every 5 min: ${spark}`);
  void clock;
}
