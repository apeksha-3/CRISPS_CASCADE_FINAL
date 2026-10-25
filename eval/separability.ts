// eval/separability.ts
// Diagnostic: how distinguishable are cascades from their NOISE lookalikes at each
// minute, using only simple observable features? Uses AUC: the chance that a random
// cascade scores higher than a random lookalike (0.5 = coin flip, 1.0 = perfectly separable).
// `npx tsx eval/separability.ts --split dev`

import { ANOMALY_KINDS, cleanStream } from "../engine/baseline";
import type { EventKind } from "../engine/types";
import { groupOf, loadSplit, type Split } from "../sim/dataset";
import type { Episode } from "../sim/truth";

const i = process.argv.indexOf("--split");
const split = (i >= 0 ? process.argv[i + 1] : "dev") as Split;
const eps = loadSplit(split);
const pos = eps.filter((e) => e.type === "cascade" || (e.type === "twin" && e.truth.twin_role === "cascade"));
const NEG = ["lookalike:rain_only", "lookalike:storm_calls", "lookalike:flu_cluster", "twin:benign"];
const neg = eps.filter((e) => NEG.includes(groupOf(e)));

function auc(a: number[], b: number[]): number {
  let s = 0;
  for (const x of a) for (const y of b) s += x > y ? 1 : x === y ? 0.5 : 0;
  return s / (a.length * b.length);
}
// anomalies (optionally of some kinds) that arrived in the last 5 minutes
function count(e: Episode, t: number, kinds?: Set<EventKind>): number {
  return cleanStream(e.events, t).events.filter((x) => x.arrived_at > t - 300 && (kinds ? kinds.has(x.kind) : ANOMALY_KINDS.has(x.kind))).length;
}
const DOWN = new Set<EventKind>(["hospital_arrivals_unusual", "power_comms_load"]);

console.log(`split ${split}: ${pos.length} cascades vs ${neg.length} NOISE lookalikes (${NEG.join(", ")})`);
console.log(" min | AUC total 5-min count | AUC hospital+power 5-min count");
for (const m of [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 25, 30]) {
  const t = m * 60;
  const a1 = auc(pos.map((e) => count(e, t)), neg.map((e) => count(e, t)));
  const a2 = auc(pos.map((e) => count(e, t, DOWN)), neg.map((e) => count(e, t, DOWN)));
  console.log(` ${String(m).padStart(3)} | ${a1.toFixed(3).padStart(21)} | ${a2.toFixed(3).padStart(30)}`);
}
