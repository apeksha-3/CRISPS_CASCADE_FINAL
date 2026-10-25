// server/eval-cache.ts
// The eval table for the dashboard. It must show the SAME numbers as `npm run eval`,
// so it never computes anything its own way:
//   1. read data/eval-results.json, which `npm run eval -- --split <s> --policy engine` writes;
//   2. if a policy is missing there, run it with the eval code itself (eval/run.ts
//      runSequence + eval/report.ts summarize, same episode order) and save it to that file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePolicy, POLICIES } from "../eval/baselines";
import { groupBy, summarize, type Summary } from "../eval/report";
import { evalOrder, runSequence } from "../eval/run";
import { loadSplit, type Split } from "../sim/dataset";

export const EVAL_FILE = () => join(process.cwd(), "data", "eval-results.json");
export const EVAL_POLICIES = Object.keys(POLICIES); // always-watch, count-threshold, engine-handset, engine

interface Saved {
  summary: Summary;
  groups: Record<string, Summary>;
  episodes?: unknown[];
}

export interface EvalView {
  split: Split;
  source: "cache" | "computed";
  policies: { name: string; summary: Summary; groups: Record<string, Summary> }[];
  limitation: string;
}

function readSaved(): Record<string, Saved> {
  const f = EVAL_FILE();
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

export function evalView(split: Split): EvalView {
  let saved = readSaved();
  let source: EvalView["source"] = "cache";
  const missing = EVAL_POLICIES.filter((p) => !saved[`${split}/${p}`]);
  if (missing.length) {
    source = "computed";
    const episodes = evalOrder(split, loadSplit(split));
    saved = readSaved(); // re-read just before writing (the CLI may have written meanwhile)
    for (const name of missing) {
      const rs = runSequence(makePolicy(name, split), episodes); // exactly eval/harness.ts run()
      saved[`${split}/${name}`] = { summary: summarize(rs), groups: Object.fromEntries(groupBy(rs).map(([g, x]) => [g, summarize(x)])), episodes: rs };
    }
    const ordered = Object.fromEntries(Object.keys(saved).sort().map((k) => [k, saved[k]]));
    writeFileSync(EVAL_FILE(), JSON.stringify(ordered, null, 1));
  }
  return {
    split,
    source,
    policies: EVAL_POLICIES.map((name) => ({ name, summary: saved[`${split}/${name}`].summary, groups: saved[`${split}/${name}`].groups })),
    limitation: "Calibrated on synthetic data only — see README LIMITATIONS for details",
  };
}
