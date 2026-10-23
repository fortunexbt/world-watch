import type { IncidentView } from "../shared/contracts";
import { MAGNITUDE_EXCERPTS } from "../shared/view";

/** Activities under the Hazards filter, in legend order: natural hazards and aviation emergencies. */
export const HAZARDS = [
  "earthquake",
  "tropical_cyclone",
  "flood",
  "wildfire",
  "volcanic_eruption",
  "drought",
  "severe_weather",
  "aviation_emergency",
] as const;
export type Hazard = (typeof HAZARDS)[number];
export const isHazard = (activity: string): activity is Hazard =>
  (HAZARDS as readonly string[]).includes(activity);
/** Estimated shaking colours by MMI, so ShakeMap contour lines never borrow an impact colour. */
export const MMI_COLORS: [number, string][] = [
  [3, "#7FB8D8"],
  [5, "#9FD08A"],
  [6, "#E4D06C"],
  [7, "#EDAB61"],
  [8, "#ED7575"],
  [9, "#C55064"],
];
/** Activities drawn with a glyph, in legend order: the hazards, then measured connectivity drops. */
export const GLYPH_ACTIVITIES = [
  ...HAZARDS,
  "connectivity_disruption",
] as const;
export type GlyphActivity = (typeof GLYPH_ACTIVITIES)[number];
export const hasGlyph = (activity: string): activity is GlyphActivity =>
  (GLYPH_ACTIVITIES as readonly string[]).includes(activity);

/** Stroked outlines on a 24-unit grid, drawn by both the map canvas (Path2D) and feed SVGs. */
export const glyphs: Record<GlyphActivity, string> = {
  earthquake: "M2 12h4l2.5-6 4 12 3-9 1.5 3H22",
  tropical_cyclone:
    "M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0M12 9C12 5 15 2.5 20 2.5M12 15c0 4-3 6.5-8 6.5",
  flood:
    "M5 10.5 12 4.5l7 6M2 15.5q2.5-3 5 0t5 0t5 0t5 0M2 20.5q2.5-3 5 0t5 0t5 0t5 0",
  wildfire:
    "M12 2.5c.5 3.5 6 6 6 11.5a6 6 0 0 1-12 0c0-3 1.5-5 3.5-6.5.2 2.2 1.2 3.5 2.8 4 .2-3.5-1-6-.3-9z",
  volcanic_eruption:
    "M3 21l5.5-10h7L21 21zM12 8V3M8.5 7.5 6.5 5M15.5 7.5l2-2.5",
  drought:
    "M15.5 10a3.5 3.5 0 1 1-7 0 3.5 3.5 0 1 1 7 0M12 2.5v1M4.5 10h1M18.5 10h1M6.7 4.7l.7.7M17.3 4.7l-.7.7M2 18h7.5l2.5 3 2.5-3H22",
  severe_weather:
    "M7 15.5a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 6.5a4.5 4.5 0 0 1 .5 9M13 11.5l-3 5h4l-3 5",
  // Lucide "plane" (ISC), the icon set the interface already ships.
  aviation_emergency:
    "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
  connectivity_disruption:
    "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 20h.01M3 3l18 18",
};

/** Map image for an incident: its activity glyph when it has one, otherwise the impact shape alone. */
export const markerIcon = (
  incident: Pick<IncidentView, "activity" | "impact">,
) =>
  hasGlyph(incident.activity)
    ? `hazard-${incident.activity}-${incident.impact}`
    : `impact-${incident.impact}`;

/** The USGS and EMSC adapters keep their event records as JSON evidence, so the magnitude is read from there rather than added to the incident contract. */
export function magnitude(incident: Pick<IncidentView, "reports">) {
  const record = incident.reports
    .flatMap((r) => r.excerpts ?? [])
    .find((e: { id?: string }) => MAGNITUDE_EXCERPTS.includes(e.id ?? ""));
  if (typeof record?.text !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(record.text).magnitude;
  } catch {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Magnitude is already logarithmic in shaking amplitude, so the radius steps linearly with it, from the M4.5 feed floor to M8. */
export function markerScale(mag: number | null) {
  if (mag === null) return 1;
  return 0.8 + 0.8 * Math.min(1, Math.max(0, (mag - 4.5) / 3.5));
}
