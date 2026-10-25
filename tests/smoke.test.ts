// tests/smoke.test.ts
// Phase 0 smoke test: types and config load, and the cost matrix is complete.

import { describe, expect, it } from "vitest";
import { ACTIONS, HYPOTHESES } from "../engine/types";
import { COST_MATRIX } from "../config/costs";
import { TRANSITIONS, BASE_RATES } from "../config/transitions";

describe("smoke", () => {
  it("cost matrix has all 4 actions x 4 hypotheses", () => {
    expect(Object.keys(COST_MATRIX).sort()).toEqual([...ACTIONS].sort());
    for (const a of ACTIONS) {
      expect(Object.keys(COST_MATRIX[a]).sort()).toEqual([...HYPOTHESES].sort());
      for (const h of HYPOTHESES) expect(typeof COST_MATRIX[a][h]).toBe("number");
    }
  });

  it("cost matrix matches the spec's starting values", () => {
    expect(COST_MATRIX.WATCH.CASCADING_CRISIS).toBe(50);
    expect(COST_MATRIX.ESCALATE.NOISE).toBe(25);
    expect(COST_MATRIX.ALERT.ISOLATED_INCIDENT).toBe(4);
  });

  it("transition rows and base rates sum to 1", () => {
    for (const h of HYPOTHESES) {
      const sum = HYPOTHESES.reduce((s, k) => s + TRANSITIONS[h][k], 0);
      expect(sum).toBeCloseTo(1, 9);
    }
    const total = HYPOTHESES.reduce((s, k) => s + BASE_RATES[k], 0);
    expect(total).toBeCloseTo(1, 9);
  });
});
