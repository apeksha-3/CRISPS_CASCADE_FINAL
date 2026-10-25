// tests/phase6.test.ts
// Phase 6 (freeze): the demo-only DEGRADED override, the committed final eval captures,
// the docs judges read, and "no engine logic changed since Phase 5".
// Needs the episodes built (npm run sim -- --build), like the server tests.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FILTER_KNOBS } from "../config/knobs";
import { loadEpisode } from "../server/episodes";
import { createApp } from "../server/index";
import { runAll } from "../server/runner";
import { findScenario } from "../server/scenarios";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

// The data lines of an SSE stream (speed=0 streams finish on their own).
async function sse(path: string): Promise<{ event: string; data: any }[]> {
  const text = await (await fetch(base + path)).text();
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)![1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) }));
}

describe("DEGRADED threshold", () => {
  it("the engine default stays 0.5 (eval integrity); the Cutout scenario asks for 0.8", () => {
    expect(FILTER_KNOBS.degraded_below_coverage).toBe(0.5);
    expect(findScenario("cutout")?.degradedBelow).toBe(0.8);
  });

  it("set to 0.8, DEGRADED fires on the cutout episode; at the default it does not", () => {
    const ep = loadEpisode("test", "test-cutout-5234");
    expect(runAll(ep, { degradedBelow: 0.8 }).some((p) => p.record.degraded)).toBe(true);
    expect(runAll(ep).some((p) => p.record.degraded)).toBe(false);
  });

  it("?degraded_threshold=0.8 on /api/replay turns the banner on; no parameter = default 0.5", async () => {
    const url = "/api/replay?split=test&episode=test-cutout-5234&speed=0";
    const demo = await sse(`${url}&degraded_threshold=0.8`);
    expect(demo[0].data.degraded_threshold).toBe(0.8);
    expect(demo[0].data.demo_threshold).toBe(true);
    expect(demo.filter((e) => e.event === "tick" && e.data.record.degraded).length).toBeGreaterThan(0);

    const plain = await sse(url);
    expect(plain[0].data.degraded_threshold).toBe(0.5);
    expect(plain[0].data.demo_threshold).toBe(false);
    expect(plain.filter((e) => e.event === "tick" && e.data.record.degraded)).toHaveLength(0);
  });

  it("a bad degraded_threshold is a 400, not a silent default", async () => {
    const r = await fetch(`${base}/api/replay?split=test&episode=test-cutout-5234&speed=0&degraded_threshold=abc`);
    expect(r.status).toBe(400);
  });
});

describe("final eval captures (committed in data/)", () => {
  const files = ["engine", "count-threshold", "always-watch", "prior-shift"].map((n) => `data/final-eval-${n}.txt`);

  it("all four exist and are non-empty", () => {
    for (const f of files) {
      expect(existsSync(f), f).toBe(true);
      expect(statSync(f).size, f).toBeGreaterThan(0);
    }
  });

  it("the engine capture shows the frozen Phase 4/5 numbers", () => {
    const txt = readFileSync("data/final-eval-engine.txt", "utf8");
    expect(txt).toMatch(/^engine\s+0\.414\s+0\.747\s+2\.62\s+2\.5%/m);
    expect(txt).toMatch(/^count-threshold\s+0\.724\s+1\.324\s+7\.73\s+34\.8%/m);
    expect(txt).toMatch(/^always-watch\s+0\.797\s+1\.493\s+44\.86\s+0\.0%/m);
  });
});

describe("submission docs", () => {
  it("the demo script and the backup-recording notes exist", () => {
    for (const f of ["docs/demo-script.md", "docs/demo-backup.md"]) {
      expect(existsSync(f), f).toBe(true);
      expect(readFileSync(f, "utf8").length).toBeGreaterThan(500);
    }
  });

  it("README has a LIMITATIONS section with at least 8 numbered items", () => {
    const readme = readFileSync("README.md", "utf8");
    const m = /^## LIMITATIONS\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme);
    expect(m, "no '## LIMITATIONS' heading").not.toBeNull();
    const items = m![1].split("\n").filter((l) => /^\d+\.\s/.test(l));
    expect(items.length).toBeGreaterThanOrEqual(8);
  });
});

describe("no engine logic changes in Phase 6", () => {
  it("engine/, config/, sim/ and eval/ are unchanged since the Phase 5 commit c3b986e", () => {
    let diff: string;
    try {
      execSync("git cat-file -e c3b986e^{commit}", { stdio: "ignore" });
      diff = execSync("git diff --name-only c3b986e -- engine config sim eval", { encoding: "utf8" });
    } catch {
      return; // not a git checkout with the Phase 5 history: nothing to compare against
    }
    expect(diff.trim()).toBe("");
  });
});
