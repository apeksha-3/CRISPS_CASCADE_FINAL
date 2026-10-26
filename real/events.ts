// real/events.ts
// Which real EVENT does an episode belong to? Episodes cut from one event (the 3 offsets of Ida, the
// 2 episodes of one dry day) share facts and must stay together: they are not independent samples.

import type { Episode } from "../sim/truth";

export function eventOf(ep: Episode): string {
  const real = (ep as unknown as { real?: { event?: string } }).real;
  return real?.event ?? ep.episode_id;
}

// "cascade", "rain_only", "rain_only+FFW", "noise" or "ambiguous" (the class the label puts the event in)
// A rain-control day on which the NWS nevertheless issued a flash flood warning for NYC is its own class, "rain_only+FFW":
// its NOISE label is less certain than that of a heavy-rain day with no warning at all.
export function classOf(ep: Episode): string {
  const h = ep.truth.hypothesis as string;
  if (h === "CASCADING_CRISIS") return "cascade";
  if (h === "UNLABELLED") return "ambiguous";
  const ffw = (ep as unknown as { real?: { ffw?: string } }).real?.ffw ?? "";
  if (ep.truth.lookalike === "rain_only" && /^[1-9]\d* OKX/.test(ffw)) return "rain_only+FFW";
  return ep.truth.lookalike ?? "noise";
}
