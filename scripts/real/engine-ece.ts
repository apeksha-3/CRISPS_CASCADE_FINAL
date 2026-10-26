// scripts/real/engine-ece.ts
// Phase 10: how well calibrated is the rules engine's P(cascade) on the simulator test split? Plays the engine exactly as
// `npm run eval -- --split test --policy engine` does (same order, same learning) and measures the expected calibration
// error (ECE, 10 equal-width bins) of P(CASCADING_CRISIS) against whether the episode really was a cascade, over every tick.
// Writes ml/engine-calibration.json, which the dashboard uses for the rules-engine confidence bar.
// Run: npx tsx scripts/real/engine-ece.ts

import { writeFileSync } from "node:fs";
import { makePolicy } from "../../eval/baselines";
import { eventLabels, evalOrder, runEpisode } from "../../eval/run";
import { loadSplit } from "../../sim/dataset";

const eps = evalOrder("test", loadSplit("test"));
const policy = makePolicy("engine", "test");
const p: number[] = [];
const y: number[] = [];
for (const ep of eps) {
  const { records } = runEpisode(policy, ep);
  policy.afterEpisode?.(ep.truth.hypothesis, eventLabels(ep));
  for (const r of records) {
    p.push(r.probabilities.CASCADING_CRISIS);
    y.push(ep.truth.hypothesis === "CASCADING_CRISIS" ? 1 : 0);
  }
}
const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
p.forEach((x, i) => { const b = bins[Math.min(9, Math.floor(x * 10))]; b.n++; b.p += x; b.y += y[i]; });
const ece = bins.reduce((s, b) => s + (b.n ? (b.n / p.length) * Math.abs(b.y / b.n - b.p / b.n) : 0), 0);
const out = { split: "test", episodes: eps.length, ticks: p.length, ece, reliability: bins.map((b, i) => ({ bin: `${i / 10}-${(i + 1) / 10}`, n: b.n, mean_pred: b.n ? b.p / b.n : null, observed: b.n ? b.y / b.n : null })) };
writeFileSync("ml/engine-calibration.json", JSON.stringify(out, null, 1) + "\n");
console.log(`engine P(cascade) on the simulator test split: ${eps.length} episodes, ${p.length} ticks, ECE ${ece.toFixed(3)}`);
for (const b of out.reliability) if (b.n) console.log(`  ${b.bin}: n ${b.n}, predicted ${b.mean_pred!.toFixed(2)}, observed ${b.observed!.toFixed(2)}`);
