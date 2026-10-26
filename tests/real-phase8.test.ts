// tests/real-phase8.test.ts
// Phase 8: the registry fix, the NWS event finder, leave-one-event-out, and the event labels.

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptDot } from "../real/adapt-dot";
import { healthyLinks, type Baselines } from "../real/baselines";
import { classOf, eventOf } from "../real/events";
import { loeoFolds } from "../real/loeo";
import { groupEvents, parseFfwBundle } from "../real/nws";
import { Unmapped } from "../real/obs";
import { LINK_HEALTH } from "../real/params";
import { buildRegistry } from "../real/registry";
import type { RealZone } from "../real/geo";
import { localIsoToUtcMs } from "../real/tz";
import type { Episode } from "../sim/truth";

const zones: RealZone[] = [{ zone_id: "mn12", name: "12 MANHATTAN", lat: 40.85, lon: -73.93, volume: 1, neighbours: [], gateway_id: "synth-gw0" }];

describe("registry fix: a DOT link is a source only if it reports on normal days", () => {
  it("healthyLinks: valid on >= 70% of the dry days with >= 144 valid reports each", () => {
    const dir = mkdtempSync(join(tmpdir(), "real-health-"));
    process.env.REAL_RAW_DIR = dir;
    try {
      const day = (valid: Record<string, number>) => {
        const rows: Record<string, string>[] = [];
        for (const [link, n] of Object.entries(valid)) for (let i = 0; i < n; i++) rows.push({ id: "1", link_id: link, data_as_of: `2022-03-01T08:${String(i % 60).padStart(2, "0")}:00.000`, speed: "40", travel_time: "1", status: "0" });
        rows.push(...Array.from({ length: 200 }, () => ({ id: "2", link_id: "dead", data_as_of: "2022-03-01T08:00:00.000", speed: "0.00", travel_time: "0", status: "-101" }))); // 'reports' but never validly
        return JSON.stringify(rows);
      };
      const days = ["2022-03-01", "2022-03-02", "2022-03-03", "2022-03-04", "2022-03-05", "2022-03-06", "2022-03-07", "2022-03-08", "2022-03-09", "2022-03-10"];
      days.forEach((d, i) => writeFileSync(join(dir, `dot-speeds__dry-${d}.json`), day({ good: 288, flaky: i < 5 ? 288 : 10, mostly: i < 7 ? 288 : 0 })));
      const ok = healthyLinks(days);
      expect(ok.has("good")).toBe(true);
      expect(ok.has("mostly")).toBe(true); // healthy on 7 of 10 days = exactly the 70% line
      expect(ok.has("flaky")).toBe(false); // healthy on 5 of 10
      expect(ok.has("dead")).toBe(false); // sends rows, never a valid one
      expect(LINK_HEALTH.day_share).toBe(0.7);
      // leave-one-day-out: dropping a healthy day of 'mostly' (7 -> 6 of 9) still needs ceil(0.7*9) = 7: it falls out
      expect(healthyLinks(days, "2022-03-01").has("mostly")).toBe(false);
      expect(healthyLinks(days, "2022-03-10").has("mostly")).toBe(true);
    } finally {
      delete process.env.REAL_RAW_DIR;
    }
  });

  const links = [{ link_id: "A", link_points: "40.85,-73.93 40.86,-73.93" }, { link_id: "B", link_points: "40.851,-73.931" }];
  it("the registry lists only the healthy links, and only they", () => {
    const all = buildRegistry(zones, links).sources.filter((s) => s.source_id.startsWith("trf-")).map((s) => s.source_id);
    expect(all).toEqual(["trf-A", "trf-B"]);
    const some = buildRegistry(zones, links, new Set(["A"])).sources.filter((s) => s.source_id.startsWith("trf-")).map((s) => s.source_id);
    expect(some).toEqual(["trf-A"]);
  });

  it("rows of an unregistered link are counted and produce no heartbeat", () => {
    const base: Baselines = { days: [], speed: new Map(), calls: new Map(), hospital: new Map() };
    const rows = [{ id: "1", link_id: "B", data_as_of: "2022-01-13T08:10:00.000", speed: "40", travel_time: "1", status: "0" }];
    const u = new Unmapped();
    const obs = adaptDot(rows, new Map([["A", "mn12"], ["B", "mn12"]]), new Map([["mn12", "g"]]), base, localIsoToUtcMs("2022-01-13T08:00:00"), localIsoToUtcMs("2022-01-13T08:45:00"), u, new Set(["A"]));
    expect(obs).toHaveLength(0);
    expect(Object.keys(u.counts)[0]).toContain("not registered");
  });
});

describe("NWS flash flood warning archive (fixture)", () => {
  const product = (head: string, vtec: string, local: string, body: string) => `\x01\n123 \n${head}\nFFWOKX\nNYC081-310030-\n${vtec}\n\nBULLETIN - EAS ACTIVATION REQUESTED\nFlash Flood Warning\nNational Weather Service New York NY\n${local}\n\n${body}\n\x03`;
  const text = [
    product("WGUS51 KOKX 020128", "/O.NEW.KOKX.FF.W.0040.210902T0128Z-210902T0330Z/", "928 PM EDT Wed Sep 1 2021", "...FLASH FLOOD EMERGENCY FOR NEW YORK CITY METRO...\n  Kings (Brooklyn) County in southeastern New York...\n  New York (Manhattan) County in southeastern New York..."),
    product("WGUS51 KOKX 020235", "/O.CON.KOKX.FF.W.0040.000000T0000Z-210902T0330Z/", "1035 PM EDT Wed Sep 1 2021", "  Queens County in southeastern New York..."),
    product("WGUS51 KOKX 100100", "/O.NEW.KOKX.FF.W.0001.210910T0100Z-210910T0300Z/", "1:00 AM EDT Fri Sep 10 2021".replace("1:00", "100"), "  Fairfield County in southern Connecticut..."), // no NYC county
    product("WGUS51 KOKX 150000", "/O.NEW.KOKX.FF.W.0002.210915T0000Z-210915T0200Z/", "800 PM EDT Tue Sep 14 2021", "  Richmond (Staten Island) County in southeastern New York..."),
  ].join("");
  it("parses time, action, NYC counties and the emergency flag", () => {
    const f = parseFfwBundle(text);
    expect(f).toHaveLength(4);
    expect(f[0]).toMatchObject({ action: "NEW", etn: "0040", issued_local: "2021-09-01T21:28:00", emergency: true, emergency_nyc: true });
    expect(f[0].nyc_counties).toEqual(["Kings", "New York"]);
    expect(f[1].issued_local).toBe("2021-09-01T22:35:00");
    expect(f[1].emergency).toBe(false);
    expect(f[2].nyc_counties).toEqual([]);
  });
  it("groups NYC products into events (8-hour gap), ignoring warnings that name no NYC county", () => {
    const events = groupEvents(parseFfwBundle(text));
    expect(events.map((e) => e.id)).toEqual(["ffw-2021-09-01", "ffw-2021-09-14"]);
    expect(events[0]).toMatchObject({ products: 2, new_products: 1, emergency_nyc: true });
    expect(events[0].boroughs).toEqual(["Kings", "New York", "Queens"]);
    expect(events[1].emergency_nyc).toBe(false);
  });
});

describe("leave-one-event-out", () => {
  const items = [
    { id: "a1", ev: "A" }, { id: "a2", ev: "A" }, { id: "b1", ev: "B" }, { id: "c1", ev: "C" }, { id: "c2", ev: "C" }, { id: "c3", ev: "C" },
  ];
  it("each event is held out once; its episodes never appear in training; the others all do", () => {
    const folds = loeoFolds(items, (x) => x.ev);
    expect(folds.map((f) => f.event)).toEqual(["A", "B", "C"]);
    for (const f of folds) {
      expect(f.test.every((x) => x.ev === f.event)).toBe(true);
      expect(f.train.some((x) => x.ev === f.event)).toBe(false);
      expect(f.train.length + f.test.length).toBe(items.length);
    }
    expect(folds[2].test.map((x) => x.id)).toEqual(["c1", "c2", "c3"]); // three offsets of one flood stay together
  });
  it("the replay script scores a held-out event with no learning between its own episodes", () => {
    const src = readFileSync(join(__dirname, "..", "scripts", "real", "replay.ts"), "utf8");
    const loeo = src.slice(src.indexOf("for (const fold of loeoFolds"), src.indexOf("return rows;", src.indexOf("for (const fold of loeoFolds")));
    expect(loeo).toMatch(/for \(const ep of fold\.train\)[\s\S]*afterEpisode/); // learning happens on the training episodes only
    expect(loeo).toMatch(/for \(const ep of fold\.test\) rows\.push\(play\(/); // test episodes are played, never fed to afterEpisode
    expect(loeo.split("afterEpisode").length - 1).toBe(1);
  });
});

describe("events and classes", () => {
  const mk = (extra: Record<string, unknown>, h = "NOISE", lookalike?: string) => ({ episode_id: "x", truth: { hypothesis: h, lookalike }, ...extra }) as unknown as Episode;
  it("episodes of one event share an event key; a rain day with an NWS warning is its own class", () => {
    expect(eventOf(mk({ real: { event: "ida-2021" } }))).toBe("ida-2021");
    expect(classOf(mk({}, "CASCADING_CRISIS"))).toBe("cascade");
    expect(classOf(mk({ real: { ffw: "6 OKX flash flood warning products" } }, "NOISE", "rain_only"))).toBe("rain_only+FFW");
    expect(classOf(mk({ real: { ffw: "0 OKX flash flood warning products" } }, "NOISE", "rain_only"))).toBe("rain_only");
    expect(classOf(mk({}, "UNLABELLED"))).toBe("ambiguous");
    expect(classOf(mk({}, "NOISE"))).toBe("noise");
  });
});

describe("Phase 8 labels", () => {
  const l8 = JSON.parse(readFileSync(join(__dirname, "..", "real", "labels-p8.json"), "utf8"));
  it("a cascade tier event cites an impact source; ambiguous events carry no hypothesis and are never scored", () => {
    expect(l8.events).toHaveLength(8);
    for (const e of l8.events) {
      expect(e.sources.length).toBeGreaterThan(0);
      for (const s of e.sources) expect(s.url).toMatch(/^https:\/\//);
      expect(e.onset_local).toBeNull(); // no onset time was cited for any of them
      expect(e.critical_local).toBeNull();
      if (e.tier === "cascade") {
        expect(e.hypothesis).toBe("CASCADING_CRISIS");
        expect(e.sources.length).toBeGreaterThan(1); // the NWS archive plus at least one impact report
      } else {
        expect(e.tier).toBe("ambiguous");
        expect(e.hypothesis).toBeNull();
      }
    }
  });
});

const BUILT = join(__dirname, "..", "data", "episodes", "real-ambiguous");
describe.skipIf(!(existsSync(BUILT) && readdirSync(BUILT).length > 0))("ambiguous episodes (cache)", () => {
  it("are kept out of the scored split and carry no truth label", () => {
    const files = readdirSync(BUILT).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(21);
    for (const f of files) expect((JSON.parse(readFileSync(join(BUILT, f), "utf8")) as Episode).truth.hypothesis as string).toBe("UNLABELLED");
    const scored = readdirSync(join(__dirname, "..", "data", "episodes", "real"));
    for (const f of files) expect(scored).not.toContain(f);
  });
});
