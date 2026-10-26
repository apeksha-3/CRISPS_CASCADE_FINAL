// tests/nowcast.test.ts
// Phase 9: the TypeScript inference function gives the same numbers as the Python reference on 100 rows, for every model and target.
// The fixtures are written by scripts/ml/train.py (the rows are real test ticks; the Python predictions come from the exported JSON,
// which train.py itself checks against scikit-learn).

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURES } from "../ml/dataset";
import { gbtScore, logisticScore, type NowcastFile, predict } from "../ml/nowcast";

const root = join(__dirname, "..");

for (const target of ["311", "traffic"]) {
  const modelPath = join(root, "ml", "models", `nowcast-${target}.json`);
  const fixturePath = join(root, "tests", "fixtures", `nowcast-${target}-rows.json`);
  // a target whose model has not been trained yet is skipped (the body reads the files, so it is not even defined)
  if (existsSync(modelPath) && existsSync(fixturePath)) describe(`nowcast ${target}: TypeScript equals Python`, () => {
    const file = JSON.parse(readFileSync(modelPath, "utf8")) as NowcastFile;
    const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as { features: string[]; rows: number[][]; logistic: number[]; logistic_raw: number[]; gbt: number[]; gbt_raw: number[]; rule: number[]; climatology: number[] };

    it("uses the data set's feature order and 100 rows", () => {
      expect(file.features).toEqual([...FEATURES]);
      expect(fx.features).toEqual([...FEATURES]);
      expect(fx.rows).toHaveLength(100);
    });
    it("logistic: raw score and calibrated probability match to 1e-9", () => {
      fx.rows.forEach((x, i) => {
        expect(logisticScore(file.models.logistic, x)).toBeCloseTo(fx.logistic_raw[i], 9);
        expect(predict(file, "logistic", x)).toBeCloseTo(fx.logistic[i], 9);
      });
    });
    it("gbt: raw score and calibrated probability match to 1e-9", () => {
      expect(file.models.gbt.trees.length).toBeGreaterThan(10);
      fx.rows.forEach((x, i) => {
        expect(gbtScore(file.models.gbt, x)).toBeCloseTo(fx.gbt_raw[i], 9);
        expect(predict(file, "gbt", x)).toBeCloseTo(fx.gbt[i], 9);
      });
    });
    it("rule and climatology match, and every probability is a probability", () => {
      fx.rows.forEach((x, i) => {
        expect(predict(file, "rule", x)).toBe(fx.rule[i]);
        expect(predict(file, "climatology", x)).toBe(fx.climatology[i]);
        for (const m of ["climatology", "rule", "logistic", "gbt"] as const) {
          const p = predict(file, m, x);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
      });
    });
    it("rejects a feature vector of the wrong length", () => {
      expect(() => predict(file, "logistic", [1, 2, 3])).toThrow();
    });
  });
}
