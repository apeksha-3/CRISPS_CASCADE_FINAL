// tests/no-truth-import.test.ts
// Guard for R8: engine/ never imports sim/ (where GroundTruth lives) or eval/
// (which reads ground truth). Scans every .ts file under engine/ (recursively)
// for static, dynamic and require imports, and checks the Phase 2 and Phase 3 files are covered.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("engine isolation", () => {
  it("no engine file imports from sim/ or eval/, or the truth types", () => {
    const files = tsFiles(join(__dirname, "..", "engine"));
    expect(files.length).toBeGreaterThan(10);
    const names = files.map((f) => f.split(/[\\/]/).pop());
    for (const f of ["adapter.ts", "validate.ts", "log.ts", "order.ts", "source-status.ts", "filter.ts", "decide.ts", "tick.ts", "cluster.ts", "grouping.ts", "forecast.ts", "explain.ts", "trust.ts", "priors.ts", "drift.ts", "learn.ts", "tune.ts"])
      expect(names).toContain(f);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const dir of ["sim", "eval"]) {
        expect(src, file).not.toMatch(new RegExp(`from\\s+["'][^"']*\\b${dir}(\\/|["'])`));
        expect(src, file).not.toMatch(new RegExp(`import\\(\\s*["'][^"']*\\b${dir}(\\/|["'])`));
        expect(src, file).not.toMatch(new RegExp(`require\\(\\s*["'][^"']*\\b${dir}(\\/|["'])`));
      }
      expect(src, file).not.toMatch(/^\s*import[^;]*\b(GroundTruth|EventTruth)\b/m); // the truth types, whatever the path
    }
  });

  it("the tick runner never calls the learning loop: the outcome only reaches engine/learn.ts, between episodes", () => {
    const dir = join(__dirname, "..", "engine");
    const tick = readFileSync(join(dir, "tick.ts"), "utf8");
    expect(tick).not.toMatch(/from\s+["']\.\/learn["']/);
    expect(tick).not.toMatch(/updateAfterEpisode|revealedOutcome/);
    // and the learning loop itself takes the outcome as a plain label, not the simulator's truth object
    expect(readFileSync(join(dir, "learn.ts"), "utf8")).toMatch(/revealedOutcome: Hypothesis/);
  });
});
