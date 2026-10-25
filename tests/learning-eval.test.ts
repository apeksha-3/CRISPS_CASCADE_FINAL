// tests/learning-eval.test.ts
// Phase 4, end to end (slower: builds dev episodes in memory, nothing on disk needed).
//   - the dev-tuned likelihood tables beat the hand-set ones on dev Brier
//   - episode order: with a fixed learned state, each episode's Brier does not depend
//     on the order; with learning on, only the learned state (prior) differs

import { describe, expect, it } from "vitest";
import { HANDSET_TABLES } from "../config/likelihoods-handset";
import { buildSplit } from "../sim/dataset";
import { generateEpisode } from "../sim/episode";
import { enginePolicy, learningFor } from "../eval/baselines";
import { summarize } from "../eval/report";
import { evalOrder, runSequence } from "../eval/run";

describe("tuned likelihoods (config/likelihoods.ts)", () => {
  it("give a lower Brier on the full dev split than the hand-set ones", { timeout: 180_000 }, () => {
    const dev = evalOrder("dev", buildSplit("dev"));
    const tuned = summarize(runSequence(enginePolicy("engine", learningFor("dev")), dev)).brier;
    const handset = summarize(runSequence(enginePolicy("engine-handset", learningFor("dev"), HANDSET_TABLES), dev)).brier;
    expect(tuned).toBeLessThan(handset);
  });
});

describe("episode order", () => {
  const eps = [
    generateEpisode("cascade", 1901),
    generateEpisode("cascade", 1906),
    generateEpisode("noise", 1902),
    generateEpisode("rain_only", 1903),
    generateEpisode("isolated_incident", 1904),
    generateEpisode("sensor_failure", 1905, { variant: "lie" }),
  ];

  it("with a fixed learned state, every episode gets the same Brier forward and backward", { timeout: 60_000 }, () => {
    const fwd = runSequence(enginePolicy("frozen", { learnPrior: false, learnTrust: false }), eps);
    const bwd = runSequence(enginePolicy("frozen", { learnPrior: false, learnTrust: false }), eps.slice().reverse()).reverse();
    expect(bwd.map((r) => r.episode_id)).toEqual(fwd.map((r) => r.episode_id));
    for (let i = 0; i < eps.length; i++) expect(bwd[i].brier).toBe(fwd[i].brier);
  });

  it("with learning on, the same episodes leave a different learned prior depending on the order", { timeout: 60_000 }, () => {
    const a = enginePolicy("a", { learnPrior: true, learnTrust: true });
    const b = enginePolicy("b", { learnPrior: true, learnTrust: true });
    runSequence(a, eps);
    runSequence(b, eps.slice().reverse());
    // backwards the 2 cascades come last, so they are remembered more strongly
    expect(b.basePrior!().CASCADING_CRISIS).toBeGreaterThan(a.basePrior!().CASCADING_CRISIS + 0.005);
    // ...but both counted the same 6 outcomes
    expect(a.learned!().drift.episode).toBe(6);
    expect(b.learned!().drift.episode).toBe(6);
  });
});
