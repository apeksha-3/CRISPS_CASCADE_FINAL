// real/episodes.ts
// Cut the fetched data into 45-minute episodes in the simulator's Episode format, so the
// UNCHANGED eval (npm run eval -- --split real) can replay them from data/episodes/real/.
//
//   cascade : each hand-labelled cascade event, cut at 3 offsets (onset 10, 20, 30 minutes in)
//   rain    : each rain control day, one episode around its heaviest rain   (NOISE, rain_only lookalike)
//   dry     : each dry control day, two episodes (08:00, 19:00)              (NOISE; baseline leaves its own day out)
//
// Nothing here reads a hidden truth: the "truth" is the hand-written label (real/labels.json).
// Stage times the data cannot supply are simply absent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Episode } from "../sim/truth";
import { buildBaselines, healthyLinks, type Baselines } from "./baselines";
import { type Context, observe, windowOf } from "./context";
import { loadIem } from "./load";
import { finalize, seedOf, Unmapped } from "./obs";
import { CASCADE_WINDOWS, DRY_EPISODE_START_HOURS, EPISODE_S, OFFSETS_MIN, RAIN_LEAD_IN_S } from "./params";
import { rainBuckets } from "./adapt-rain";
import { buildRegistry, STATIONS } from "./registry";
import { addDays, localIsoToUtcMs, utcMsToLocalIso, utcStringToMs } from "./tz";

export interface Labels {
  cascades: {
    event_id: string;
    window: string;
    hypothesis: string;
    start_rule: string;
    offsets_min: number[];
    onset_local: string | null;
    critical_local: string | null;
    onset_source: { url: string; what: string };
    critical_source: { url: string; what: string };
    confidence: string;
  }[];
  controls: Record<"rain" | "dry", { hypothesis: string; lookalike_type?: string; start_rule: string; source: { url: string; what: string }; confidence: string }>;
  empty_classes: Record<string, string>;
}

export const loadLabels = (): Labels => JSON.parse(readFileSync(join(process.cwd(), "real", "labels.json"), "utf8"));

// Phase 8 events (real/labels-p8.json): same shape plus a tier.
export interface Labels8 {
  start_rule: string;
  offsets_min: number[];
  events: { event_id: string; window: string; tier: "cascade" | "ambiguous"; hypothesis: string | null; first_nyc_warning_local: string; onset_local: string | null; critical_local: string | null; sources: { url: string; what: string }[]; confidence: string }[];
}
export const loadLabels8 = (): Labels8 => JSON.parse(readFileSync(join(process.cwd(), "real", "labels-p8.json"), "utf8"));

// The start (UTC ms) of the heaviest `minutes` of rain in a window's IEM rows, over the 3 stations.
// A candidate window needs at least 80% valid minutes. Ties go to the earliest.
export function heaviestRain(rows: Record<string, string>[], minutes: number): number {
  let best = { sum: -1, start: 0 };
  for (const station of Object.keys(STATIONS)) {
    const per = new Map<number, number>();
    for (const r of rows) {
      if (r.station !== station) continue;
      const v = Number(r.precip);
      if (r.precip === "" || r.precip === "M" || !Number.isFinite(v)) continue;
      per.set(utcStringToMs(r["valid(UTC)"]), v);
    }
    const times = [...per.keys()].sort((a, b) => a - b);
    for (const t0 of times) {
      let sum = 0;
      let n = 0;
      for (let k = 0; k < minutes; k++) {
        const v = per.get(t0 + k * 60_000);
        if (v !== undefined) {
          sum += v;
          n++;
        }
      }
      if (n >= 0.8 * minutes && sum > best.sum) best = { sum, start: t0 };
    }
  }
  if (best.sum < 0) throw new Error("no usable rain minutes in window");
  return best.start;
}

export interface BuiltEpisode {
  tier: "cascade" | "ambiguous" | "control"; // ambiguous = watched, never scored (no cited cascade-class impact)
  episode: Episode;
  startMs: number;
  startLocal: string;
  counts: Record<string, number>;
}

function makeEpisode(
  ctx: Context,
  o: {
    id: string;
    windowId: string;
    startMs: number;
    type: "cascade" | "lookalike" | "noise";
    hypothesis: string;
    lookalike?: string;
    onsetMs?: number;
    criticalMs?: number;
    base: Baselines;
    unmapped: Unmapped;
    tier?: "cascade" | "ambiguous";
    healthy?: Set<string>; // DOT links registered as sources (undefined = every link, the Phase 7 behaviour)
    label: Record<string, unknown>;
  },
): BuiltEpisode {
  const obs = observe(ctx, o.windowId, o.startMs, o.startMs + EPISODE_S * 1000, o.base, o.unmapped, o.healthy);
  const events = finalize(obs, o.id, o.startMs);
  const truth: Record<string, unknown> = {
    hypothesis: o.hypothesis,
    episode_type: o.type,
    stage_times: {},
    stages: [],
    build_attempt: 0,
    cutouts: [],
    failed_gateways: [],
    surge: false,
    drifting_sources: [],
    weather: "normal",
    sources: [],
    event_truths: {},
  };
  if (o.lookalike) truth.lookalike = o.lookalike;
  if (o.onsetMs !== undefined) truth.onset = Math.round((o.onsetMs - o.startMs) / 1000);
  if (o.criticalMs !== undefined) truth.critical_time = Math.round((o.criticalMs - o.startMs) / 1000);
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const episode = {
    episode_id: o.id,
    seed: seedOf(o.id),
    type: o.type,
    duration: EPISODE_S,
    registry: o.healthy ? buildRegistry(ctx.zones, ctx.links, o.healthy) : ctx.registry,
    events,
    truth,
    real: { window: o.windowId, start_local: utcMsToLocalIso(o.startMs), start_utc: new Date(o.startMs).toISOString(), ...o.label },
  } as unknown as Episode;
  return { tier: o.tier ?? "control", episode, startMs: o.startMs, startLocal: utcMsToLocalIso(o.startMs), counts };
}

export interface BuildOptions {
  phase8Events?: boolean; // add the Phase 8 events (real/labels-p8.json); false reproduces the Phase 7 episode set
  registry: "all" | "healthy"; // all = Phase 7 (every DOT link); healthy = Phase 8 (only links that report on normal days)
}

export function buildAll(ctx: Context, unmapped: Unmapped, opts: BuildOptions = { registry: "healthy" }): BuiltEpisode[] {
  const labels = loadLabels();
  const out: BuiltEpisode[] = [];
  const dry = ctx.controls.dry;
  const allDry = buildBaselines(dry, ctx.zones);
  const healthyAll = opts.registry === "healthy" ? healthyLinks(dry) : undefined;

  // ---- cascades ----
  for (const c of labels.cascades) {
    const rows = loadIem(c.window);
    const onsetMs = c.onset_local ? localIsoToUtcMs(c.onset_local) : undefined;
    const anchorMs = onsetMs ?? heaviestRain(rows, 60);
    for (const off of c.offsets_min.length ? c.offsets_min : OFFSETS_MIN) {
      out.push(
        makeEpisode(ctx, {
          id: `real-${c.event_id}-on${off}`,
          windowId: c.window,
          startMs: anchorMs - off * 60_000,
          type: "cascade",
          hypothesis: c.hypothesis,
          onsetMs,
          criticalMs: c.critical_local ? localIsoToUtcMs(c.critical_local) : undefined,
          base: allDry,
          unmapped,
          tier: "cascade",
          healthy: healthyAll,
          label: { event: c.event_id, offset_min: off, anchor: onsetMs !== undefined ? "onset_local (NWS flash flood emergency)" : "heaviest 60 min of rain (data-derived anchor, not an onset)", onset_local: c.onset_local, critical_local: c.critical_local, confidence: c.confidence, onset_source: c.onset_source, critical_source: c.critical_source },
        }),
      );
    }
  }

  // ---- Phase 8 events: tier cascade is scored, tier ambiguous is only watched ----
  if (opts.phase8Events) {
    const l8 = loadLabels8();
    for (const ev of l8.events) {
      const anchorMs = heaviestRain(loadIem(ev.window), 60);
      for (const off of l8.offsets_min) {
        out.push(
          makeEpisode(ctx, {
            id: `real-${ev.event_id}-on${off}`,
            windowId: ev.window,
            startMs: anchorMs - off * 60_000,
            type: "cascade",
            hypothesis: ev.hypothesis ?? "UNLABELLED",
            tier: ev.tier,
            base: allDry,
            unmapped,
            healthy: healthyAll,
            label: { event: ev.event_id, offset_min: off, tier: ev.tier, anchor: "heaviest 60 min of rain (data-derived anchor, not an onset)", onset_local: ev.onset_local, critical_local: ev.critical_local, confidence: ev.confidence, sources: ev.sources },
          }),
        );
      }
    }
  }

  // ---- rain controls: NOISE, rain_only lookalike ----
  const rc = labels.controls.rain;
  for (const day of ctx.controls.rain) {
    const w = `rain-${day}`;
    const dayStart = localIsoToUtcMs(`${day}T00:00:00`);
    const dayEnd = localIsoToUtcMs(`${addDays(day, 1)}T00:00:00`);
    const peak = heaviestRain(loadIem(w), 30);
    const startMs = Math.min(dayEnd - EPISODE_S * 1000, Math.max(dayStart, peak - RAIN_LEAD_IN_S * 1000));
    out.push(
      makeEpisode(ctx, { id: `real-rain-${day}`, windowId: w, startMs, type: "lookalike", hypothesis: rc.hypothesis, lookalike: rc.lookalike_type, base: allDry, unmapped, healthy: healthyAll, label: { event: w, anchor: "heaviest 30 min of rain", confidence: rc.confidence, source: rc.source, ffw: ctx.controls.ffw[day] } }),
    );
  }

  // ---- dry controls: NOISE; baseline leaves the episode's own day out ----
  const dc = labels.controls.dry;
  for (const day of dry) {
    const base = buildBaselines(dry, ctx.zones, day);
    const healthy = opts.registry === "healthy" ? healthyLinks(dry, day) : undefined; // leave-one-day-out, like the baseline
    for (const h of DRY_EPISODE_START_HOURS) {
      const hh = String(h).padStart(2, "0");
      out.push(
        makeEpisode(ctx, { id: `real-dry-${day}-${hh}00`, windowId: windowOf(ctx, day, CASCADE_WINDOWS), startMs: localIsoToUtcMs(`${day}T${hh}:00:00`), type: "noise", hypothesis: dc.hypothesis, base, unmapped, healthy, label: { event: `dry-${day}`, anchor: `${hh}:00 local`, confidence: dc.confidence, source: dc.source, baseline_days: base.days } }),
      );
    }
  }
  return out;
}

export { rainBuckets };
