// real/adapt-311.ts
// NYC 311 -> citizen reports. One anonymous source per community board (cit-<zone>); the request
// itself (address, free text) is never kept, only the category.
//
// Mapping (complaint_type / descriptor -> what the engine sees):
//   Sewer, "Street Flooding" / "Highway Flooding" / "Rain Garden Flooding"
//                                         -> citizen_report, kind "citizen_report"  ("flood report")
//   Water System, "Excessive Water In Basement"            -> citizen_report  ("flooded basement")
//   Sewer, "Catch Basin Clogged/Flooding", "Manhole Overflow", "Sewer Backup", "Culvert Blocked"
//                                         -> citizen_report source, kind "drainage_anomaly"
//   ELECTRIC (HPD building electrical complaint)
//                                         -> utility source, kind "power_comms_load".
//                                            WEAK PROXY: it is a building wiring complaint, not grid load or an outage.
//   anything else (hydrants, leaks, odor, ...) -> unmapped, counted by reason.
// 311 has no severity field and none is invented: reported_severity stays absent.
// The legacy names in the brief ("Catch Basin", "Street Flooding", "Flooded Basement" as
// complaint types) are handled too, in case the portal ever uses them.

import { localIsoToUtcMs } from "./tz";
import { type Obs, Unmapped } from "./obs";
import { type RealZone, zoneIdOfBoard } from "./geo";

type Mapping = { kind: "citizen_report" | "drainage_anomaly" | "power_comms_load"; type: "citizen_report" | "utility"; label: string };

export function map311(complaint: string, descriptor: string): Mapping | undefined {
  const c = complaint.trim().toLowerCase();
  const d = descriptor.trim().toLowerCase();
  if (c === "electric") return { kind: "power_comms_load", type: "utility", label: "electric complaint (weak power proxy)" };
  if (c === "street flooding" || (c === "sewer" && /street flooding|highway flooding|rain garden flooding/.test(d))) return { kind: "citizen_report", type: "citizen_report", label: "street flooding" };
  if (c === "flooded basement" || (c === "water system" && /excessive water in basement/.test(d))) return { kind: "citizen_report", type: "citizen_report", label: "flooded basement" };
  if (c === "catch basin" || (c === "sewer" && /catch basin clogged|manhole overflow|sewer backup|culvert blocked/.test(d))) return { kind: "drainage_anomaly", type: "citizen_report", label: "drainage problem" };
  return undefined;
}

export function adapt311(rows: Record<string, string>[], zones: RealZone[], fromMs: number, toMs: number, unmapped: Unmapped): Obs[] {
  const known = new Set(zones.map((z) => z.zone_id));
  const out: Obs[] = [];
  for (const r of rows) {
    const t = localIsoToUtcMs(r.created_date);
    if (t < fromMs || t >= toMs) continue;
    const m = map311(r.complaint_type ?? "", r.descriptor ?? "");
    if (!m) {
      unmapped.add(`311: not a flooding, drainage or electric complaint (${r.complaint_type} / ${(r.descriptor ?? "").replace(/\s*\(.*$/, "")})`);
      continue;
    }
    const zone = zoneIdOfBoard(r.community_board);
    if (!zone) {
      unmapped.add("311: no usable community board");
      continue;
    }
    if (!known.has(zone)) {
      unmapped.add("311: community board is not one of the 10 selected zones");
      continue;
    }
    out.push({
      id: `311:${r.unique_key}`,
      source_id: m.type === "utility" ? `utl-${zone}` : `cit-${zone}`,
      source_type: m.type,
      zone_id: zone,
      kind: m.kind,
      t_ms: t,
      text: `311 ${m.label}`,
    });
  }
  return out;
}
