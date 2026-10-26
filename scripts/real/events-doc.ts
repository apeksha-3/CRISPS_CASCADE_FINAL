// scripts/real/events-doc.ts
// Phase 8 step C4. Write docs/real-events.md: every NWS candidate event, the rain ranking and coverage check, and the
// 10 events used (2 from Phase 7 + 8 new) with their tier and sources.
// Run: npx tsx scripts/real/events-doc.ts

import { readFileSync, writeFileSync } from "node:fs";
import type { FloodEvent } from "../../real/nws";

const cand = JSON.parse(readFileSync("real/candidates.json", "utf8")) as { events: FloodEvent[] };
const rank = JSON.parse(readFileSync("real/ranking.json", "utf8")) as { ranked_by_rain: (FloodEvent & { peak60_mm?: number; coverage?: { dot: number[]; ems: number[]; c311: number[]; ok: boolean } })[]; usable_in_rain_order: string[] };
const l7 = JSON.parse(readFileSync("real/labels.json", "utf8"));
const l8 = JSON.parse(readFileSync("real/labels-p8.json", "utf8"));

const L: string[] = [
  "# Real events (Phase 8)",
  "",
  "Written by `scripts/real/events-doc.ts` from `real/candidates.json`, `real/ranking.json`, `real/labels.json` and `real/labels-p8.json`.",
  "",
  "## 1. Every NWS flash flood event that named a New York City county, 2019 to now",
  "",
  "Source: the IEM archive of NWS text products (`pil=FFWOKX`, the New York office), queried by half-year (`scripts/real/events-find.ts`).",
  "An event is a run of warning products that name a NYC county (Bronx, Kings, New York, Queens, Richmond) with gaps under 8 hours.",
  `${cand.events.length} events; ${cand.events.filter((e) => e.emergency_nyc).length} with a flash flood EMERGENCY for NYC (Ida, 1 Sep 2021). All times NYC local.`,
  "",
  "| event | first NYC warning | last product | products | NEW | NYC emergency | counties named |",
  "|---|---|---|---|---|---|---|",
  ...cand.events.map((e) => `| ${e.id} | ${e.first_local.replace("T", " ").slice(0, 16)} | ${e.last_local.replace("T", " ").slice(5, 16)} | ${e.products} | ${e.new_products} | ${e.emergency_nyc ? "YES" : "no"} | ${e.boroughs.join(", ")} |`),
  "",
  "## 2. Ranking by rain, and the data coverage check",
  "",
  "Events are ranked by the heaviest 60 minutes of rain at KNYC, KJFK or KLGA (IEM 1-minute data). The 30 heaviest are checked for coverage:",
  "an event is usable if, on its first local day and the next, DOT has at least 20,000 rows, EMS at least 3,000 and 311 (all types) at least 3,000.",
  "Selection used only rain and coverage, never engine output. 2019 events fail the 311 check (no rows: the dataset returns nothing for those days).",
  "",
  "| rank | event | heaviest 60 min (mm) | DOT rows day1/day2 | EMS rows | 311 rows | usable | used |",
  "|---|---|---|---|---|---|---|---|",
  ...rank.ranked_by_rain.filter((e) => e.coverage).map((e, i) => `| ${i + 1} | ${e.id} | ${e.peak60_mm ?? "-"} | ${e.coverage!.dot.join(" / ")} | ${e.coverage!.ems.join(" / ")} | ${e.coverage!.c311.join(" / ")} | ${e.coverage!.ok ? "yes" : "NO"} | ${rank.usable_in_rain_order.includes(e.id) ? "yes" : ""} |`),
  "",
  "## 3. The 10 events used, with tier and sources",
  "",
  "Tier **cascade**: the label is CASCADING_CRISIS because a cited source shows an NYC-wide impact (flash flood emergency, emergency declaration, or flood-caused multi-line subway suspension). Scored.",
  "Tier **ambiguous**: an NWS flash flood warning named NYC counties and the data coverage is good, but no cited source shows a cascade-class impact. Watched only, never scored as cascade or noise.",
  "Onset and critical times are null unless a source gives a time (only Ida has both).",
  "",
  `### ${l7.cascades[0].event_id}: cascade (Phase 7)`,
  "",
  `- onset ${l7.cascades[0].onset_local} (${l7.cascades[0].onset_source.what}) [source](${l7.cascades[0].onset_source.url})`,
  `- critical ${l7.cascades[0].critical_local} (${l7.cascades[0].critical_source.what}) [source](${l7.cascades[0].critical_source.url})`,
  `- confidence: ${l7.cascades[0].confidence}`,
  "",
  `### ${l7.cascades[1].event_id}: cascade (Phase 7)`,
  "",
  `- onset null, critical null. ${l7.cascades[1].onset_source.what} [source](${l7.cascades[1].onset_source.url})`,
  `- ${l7.cascades[1].critical_source.what} [source](${l7.cascades[1].critical_source.url})`,
  `- confidence: ${l7.cascades[1].confidence}`,
  "",
  ...l8.events.flatMap((e: { event_id: string; tier: string; first_nyc_warning_local: string; peak60_mm: number; sources: { url: string; what: string }[]; confidence: string }) => [
    `### ${e.event_id}: ${e.tier}`,
    "",
    `- first NYC warning ${e.first_nyc_warning_local.replace("T", " ").slice(0, 16)}, heaviest 60 minutes of rain ${e.peak60_mm} mm`,
    ...e.sources.map((s) => `- ${s.what} [source](${s.url})`),
    `- confidence: ${e.confidence}`,
    "",
  ]),
  "## 4. Honest limits of this list",
  "",
  "- Only Ida (a flash flood emergency) and two later events (an emergency declaration; a cited multi-line subway suspension) meet the cascade tier. The other 7 events are warnings with documented heavy rain and no verified citywide impact. That is 3 cascade events, still fewer than the 5 needed to say anything statistical.",
  "- Impact searches were done by web search; several returned secondary or mixed-up items, so a claim is made only where a fetched page supports it.",
  "- The DOT link inventory drifts with time (see the Phase 8 report): events in 2025 and 2026 are scored against a link registry and baselines built from 2022 dry days.",
  "",
];
writeFileSync("docs/real-events.md", L.join("\n"));
console.log(`wrote docs/real-events.md (${cand.events.length} candidate events, ${rank.usable_in_rain_order.length} usable, ${l8.events.length + 2} used)`);
