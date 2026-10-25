// sim/cli.ts
// `npm run sim -- --build`                      build dev/test/prior-shift into data/episodes/
// `npm run sim -- --stats`                      size/duration table for the built data
// `npm run sim -- --type cascade --seed 7 --print`   readable timeline of one episode
//     --type: noise | sensor_failure | isolated | cascade | rain_only | storm_calls |
//             flu_cluster | gateway_outage | twin | cutout | rumor_wave |
//             duplicate_storm | surge | drifting
//     --variant <v>  (e.g. outage|lie, cameras|gateway, pure|with_real)   --fuzz   --json

import { buildPriorShift, buildSplit, groupOf, loadSplit, type Split, writeSplit } from "./dataset";
import { type BuildOptions, countSignalEvents, generateEpisode, generateTwinPair, type ScenarioName, SCENARIO_NAMES } from "./episode";
import { statsTable, timeline } from "./print";
import type { Episode } from "./truth";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function summary(name: string, eps: Episode[]): string {
  const groups = new Map<string, number[]>();
  for (const ep of eps) {
    const g = groupOf(ep);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(countSignalEvents(ep.events));
  }
  const lines = [`${name}: ${eps.length} episodes`];
  for (const g of [...groups.keys()].sort()) {
    const n = groups.get(g)!;
    lines.push(`  ${g.padEnd(26)} ${String(n.length).padStart(3)} episodes, mean ${(n.reduce((s, x) => s + x, 0) / n.length).toFixed(0)} non-heartbeat events`);
  }
  const all = eps.map((e) => countSignalEvents(e.events));
  lines.push(`  ${"ALL".padEnd(26)} ${String(eps.length).padStart(3)} episodes, mean ${(all.reduce((s, x) => s + x, 0) / all.length).toFixed(0)} non-heartbeat events (${(eps.reduce((s, e) => s + e.events.length, 0) / eps.length).toFixed(0)} incl. heartbeats)`);
  return lines.join("\n");
}

function main(): void {
  if (flag("build")) {
    const sets: [Split, Episode[]][] = [
      ["dev", buildSplit("dev")],
      ["test", buildSplit("test")],
      ["prior-shift", buildPriorShift()],
    ];
    for (const [name, eps] of sets) {
      const dir = writeSplit(name, eps);
      console.log(summary(name, eps));
      console.log(`  -> wrote ${dir}\n`);
    }
    return;
  }
  if (flag("stats")) {
    const splits: [string, Episode[]][] = (["dev", "test", "prior-shift"] as Split[]).map((s) => [s, loadSplit(s)]);
    console.log(statsTable(splits));
    return;
  }
  const type = arg("type");
  if (type) {
    const seed = Number(arg("seed") ?? "1");
    const opts: BuildOptions = { variant: arg("variant"), fuzz: flag("fuzz") };
    if (type === "twin") {
      const [a, b] = generateTwinPair(seed, opts);
      const split = a.truth.split_time!;
      const pa = a.events.filter((e) => e.arrived_at <= split);
      const pb = b.events.filter((e) => e.arrived_at <= split);
      const same = JSON.stringify(pa) === JSON.stringify(pb);
      if (flag("json")) return void console.log(JSON.stringify([a, b]));
      console.log(timeline(a, { splitAt: split }));
      console.log("\n");
      console.log(timeline(b, { splitAt: split }));
      console.log(`\nPrefix check (arrived_at <= ${split} s): A has ${pa.length} events (${countSignalEvents(pa)} non-heartbeat), B has ${pb.length} (${countSignalEvents(pb)} non-heartbeat). Byte-identical: ${same ? "YES" : "NO"}`);
      return;
    }
    const name = (type === "isolated" ? "isolated_incident" : type) as ScenarioName;
    if (!SCENARIO_NAMES.includes(name)) throw new Error(`unknown --type ${type}`);
    const ep = generateEpisode(name, seed, opts);
    if (flag("json")) return void console.log(JSON.stringify(ep));
    console.log(timeline(ep));
    return;
  }
  console.log("usage: npm run sim -- --build | --stats | --type <name> --seed <n> --print [--variant v] [--fuzz] [--json]");
}

main();
