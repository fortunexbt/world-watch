import type { IncidentView } from "./contracts";
import { incidentInWindow } from "./temporal";
/** Bounding boxes are [west, south, east, north]; west > east crosses the antimeridian. */
export function inBbox(location: IncidentView["location"], bbox: number[]) {
  if (!location) return false;
  const radius = location.radius_km / 111;
  const lonRadius =
    radius / Math.max(0.05, Math.cos((location.lat * Math.PI) / 180));
  return (
    location.lat + radius >= bbox[1] &&
    location.lat - radius <= bbox[3] &&
    lonOverlaps(location.lon, lonRadius, bbox[0], bbox[2])
  );
}
/** Whether lon ± reach meets the span running east from west to east, across the antimeridian if needed. */
export function lonOverlaps(
  lon: number,
  reach: number,
  west: number,
  east: number,
) {
  const width = east >= west ? east - west : east - west + 360;
  const offset = (((lon - west) % 360) + 360) % 360;
  return (
    width + 2 * reach >= 360 || offset <= width + reach || offset >= 360 - reach
  );
}
/** Plain substring search over what a viewer reads; the live API uses full-text search instead. */
export const textMatch = (i: IncidentView, query: string) =>
  JSON.stringify([i.headline, i.summary_en, i.location, i.reports])
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase());
const FIELDS = [
  ["activity", (i: IncidentView, v: string) => i.activity === v],
  ["evidence", (i: IncidentView, v: string) => i.evidence_status === v],
  [
    "source",
    (i: IncidentView, v: string) =>
      i.reports.some((r: any) => r.source_id === v),
  ],
  [
    "language",
    (i: IncidentView, v: string) =>
      i.reports.some((r: any) => r.original_language === v),
  ],
] as const;
/** The snapshot query's field, time-window and area filters. A replay (`at`) has no live window. */
export function viewFilter(params: URLSearchParams, bbox?: number[]) {
  const fields = FIELDS.flatMap(([key, match]) => {
      const value = params.get(key);
      return value ? [(i: IncidentView) => match(i, value)] : [];
    }),
    hours = params.get("at") ? 0 : Number(params.get("hours"));
  return (i: IncidentView) =>
    fields.every((match) => match(i)) &&
    (!(hours > 0) || incidentInWindow(i, hours)) &&
    (!bbox || inBbox(i.location, bbox));
}

/** The USGS and EMSC excerpts the map reads a quake's magnitude from (client/hazards.ts). */
export const MAGNITUDE_EXCERPTS = ["usgs-event", "emsc-event"];
/**
 * The fields the feed, map, filters and situation grouping read. Summaries, other evidence text,
 * rights wording and detailed footprints stay with the detail endpoint, which a selected incident
 * is read from; the map draws every other footprint from its coarser display copy.
 */
export function listView(i: IncidentView) {
  const { summary_en, summary_it, footprint, ...rest } = i;
  return {
    ...rest,
    ...(footprint
      ? {
          footprint: { role: footprint.role, display: footprint.display },
        }
      : {}),
    reports: i.reports.map(({ excerpts, rights, ...report }: any) => ({
      ...report,
      excerpts: (excerpts ?? []).filter((e: { id?: string }) => MAGNITUDE_EXCERPTS.includes(e.id ?? "")),
      rights: rights && { access: rights.access, storage: rights.storage, ai: rights.ai, display: rights.display, redistribute: rights.redistribute },
    })),
  };
}
