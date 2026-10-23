import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { countryAt } from "../../shared/borders.js";

/** EMSC's FDSN event service at SeismicPortal, which answers JSON and 204 No Content for an empty query. */
export const EMSC_QUERY_URL =
  "https://www.seismicportal.eu/fdsnws/event/1/query";
/** A full page could hide older events. The past day at M4.5+ held 19 events on 21 October 2026 and 27 on 23 October. */
export const EMSC_LIMIT = 500;
/** Known and suspected earthquakes; EMSC's other event types (explosions, quarry blasts) are outside hazard scope. */
const EVENT_TYPE = {
  ke: "known earthquake",
  se: "suspected earthquake",
} as const;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const stamp = (value: unknown): string | null => {
  const v = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v)) return null;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** The past day worldwide from the minute, at the USGS feed's M4.5 floor so the two catalogues cover the same quakes. */
export function emscQueryURL(now: number) {
  const start = Math.floor(now / 60000) * 60000 - 86400000;
  return (
    EMSC_QUERY_URL +
    "?" +
    new URLSearchParams({
      format: "json",
      starttime: new Date(start).toISOString().slice(0, 19),
      minmag: "4.5",
      orderby: "time",
      limit: String(EMSC_LIMIT),
    })
  );
}

/** One EMSC event list. The unid is the native ID, and the last update time and preferred origin ID mark revisions. */
export function parseEmsc(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  const data = payload as any;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("invalid_emsc_response");
  if (
    data.metadata?.count !== data.features.length ||
    data.features.length >= EMSC_LIMIT
  )
    throw Error("emsc_feed_truncated");
  return data.features.flatMap((feature: any) => {
    const p = feature?.properties ?? {};
    const id = text(p.unid) || text(feature?.id);
    const origin = stamp(p.time);
    const type = text(p.evtype) as keyof typeof EVENT_TYPE;
    if (!id || !Object.hasOwn(EVENT_TYPE, type) || !origin) return [];
    const [lon, lat] = Array.isArray(feature.geometry?.coordinates)
      ? feature.geometry.coordinates
      : [];
    const hasPoint =
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90;
    const updated = stamp(p.lastupdate) ?? origin;
    const region = text(p.flynn_region);
    const magnitude = Number.isFinite(p.mag) ? p.mag : null;
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url:
          "https://www.seismicportal.eu/eventdetails.html?unid=" +
          encodeURIComponent(id),
        title: `${magnitude === null ? "Earthquake" : "M " + magnitude.toFixed(1)} - ${region || id}`,
        original_language: "en",
        published_at: null,
        source_updated_at: updated,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          {
            id: "emsc-event",
            text: JSON.stringify({
              magnitude,
              magnitude_type: text(p.magtype) || null,
              place: region || null,
              origin_time: origin,
              source_updated_at: updated,
              // EMSC writes depth positive in properties and negative as the point's third coordinate.
              depth_km: Number.isFinite(p.depth) ? p.depth : null,
              event_type: EVENT_TYPE[type],
              author: text(p.auth) || null,
              origin_id: text(p.source_id) || null,
              catalogue: text(p.source_catalog) || null,
              notice:
                "EMSC-CSEM earthquake record, CC BY 4.0, credit EMSC-CSEM SeismicPortal, https://www.seismicportal.eu. The author is the agency whose solution EMSC publishes as preferred; NEIC is the USGS National Earthquake Information Center, so such a record repeats the USGS solution rather than corroborating it. A suspected earthquake is not yet confirmed by EMSC. The point is the epicentre, not the shaking footprint. Any country is derived from the epicentre and the map's Natural Earth boundaries, and is left empty offshore or near a coast or border. EMSC issues no alert level, so impact stays unknown. EMSC gives no warranty of completeness, accuracy or timeliness.",
            }),
          },
        ],
        ...(hasPoint
          ? {
              source_geo: {
                lon,
                lat,
                name: region || "Epicentre",
                accuracy: "point" as const,
                // EMSC names a Flynn-Engdahl region, not a country; this is the map's own boundary data.
                country: countryAt(lon, lat),
              },
            }
          : {}),
        official: {
          issuer: "European-Mediterranean Seismological Centre",
          effective_at: origin,
          expires_at: null,
          activity: "earthquake" as const,
          impact: "unknown" as const,
        },
      },
    ];
  });
}
