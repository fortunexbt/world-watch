import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { countryAt } from "../../shared/borders.js";
import { buildFootprint } from "../../shared/footprint.js";

/** Complete past-day ComCat summary; M4.5 is the global completeness level, smaller events are mostly US-network only. */
export const USGS_FEED_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";
/** PAGER levels are modelled fatality/loss estimates, not stated harm, so red never becomes critical. */
export const PAGER_IMPACT = {
  green: "minor",
  yellow: "significant",
  orange: "severe",
  red: "severe",
} as const;
const stamp = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** USGS earthquake summary GeoJSON. Non-earthquake seismic types (quarry blasts, explosions) are outside hazard scope. */
export function parseUsgs(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  const data = payload as any;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("invalid_usgs_response");
  if (data.metadata?.count !== data.features.length)
    throw Error("usgs_feed_truncated");
  return data.features.flatMap((feature: any) => {
    const p = feature?.properties ?? {};
    const id = text(feature?.id);
    const origin = stamp(p.time);
    if (!id || p.type !== "earthquake" || !origin) return [];
    const [lon, lat, depth] = Array.isArray(feature.geometry?.coordinates)
      ? feature.geometry.coordinates
      : [];
    const hasPoint =
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90;
    const updated = stamp(p.updated) ?? origin;
    const place = text(p.place);
    const alert = Object.hasOwn(PAGER_IMPACT, p.alert)
      ? (p.alert as keyof typeof PAGER_IMPACT)
      : null;
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url:
          "https://earthquake.usgs.gov/earthquakes/eventpage/" +
          encodeURIComponent(id),
        title: text(p.title) || `Earthquake — ${place || id}`,
        original_language: "en",
        published_at: null,
        source_updated_at: updated,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          {
            id: "usgs-event",
            text: JSON.stringify({
              magnitude: Number.isFinite(p.mag) ? p.mag : null,
              magnitude_type: text(p.magType) || null,
              place: place || null,
              origin_time: origin,
              source_updated_at: updated,
              depth_km: Number.isFinite(depth) ? depth : null,
              pager_alert: alert,
              tsunami_flag: p.tsunami === 1,
              review_status: text(p.status) || null,
              // The contributing network ComCat prefers for this event, such as us for NEIC or ak for Alaska.
              preferred_network: text(p.net) || null,
              network_ids: text(p.ids).split(",").filter(Boolean),
              notice:
                "U.S. Geological Survey earthquake record. The point is the epicentre, not the shaking footprint. Any country is derived from the epicentre and the map's Natural Earth boundaries, and is left empty offshore or near a coast or border. A PAGER alert is a modelled estimate of fatalities and losses, not observed harm, and null means none was issued. The tsunami flag marks a large oceanic event and does not mean a tsunami occurred.",
            }),
          },
        ],
        ...(hasPoint
          ? {
              source_geo: {
                lon,
                lat,
                name: place || "Epicentre",
                accuracy: "point" as const,
                // USGS states no country; this is the map's own boundary data, never a geocoding service.
                country: countryAt(lon, lat),
              },
            }
          : {}),
        official: {
          issuer: "U.S. Geological Survey",
          effective_at: origin,
          expires_at: null,
          activity: "earthquake" as const,
          impact: alert ? PAGER_IMPACT[alert] : ("unknown" as const),
        },
      },
    ];
  });
}

/** ShakeMap contours are read for quakes with a PAGER alert or at least this magnitude. */
export const SHAKEMAP_MAGNITUDE = 6;
/** The event's detail GeoJSON when its ShakeMap is worth a read, otherwise null. */
export function shakeMapDetailURL(o: ObservationInput) {
  const event = JSON.parse(
    o.excerpts.find((e) => e.id === "usgs-event")?.text ?? "{}",
  );
  return event.pager_alert || event.magnitude >= SHAKEMAP_MAGNITUDE
    ? "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/" +
        encodeURIComponent(o.native_id) +
        ".geojson"
    : null;
}
/** The preferred ShakeMap's MMI contour file named by an event detail, or null when it has none. */
export function shakeMapContoursURL(detail: any): string | null {
  // ComCat lists each product type's preferred version first.
  const url =
    detail?.properties?.products?.shakemap?.[0]?.contents?.[
      "download/cont_mmi.json"
    ]?.url;
  return typeof url === "string" ? url : null;
}
/** ShakeMap cont_mmi.json: one MultiLineString of estimated shaking per MMI value. Contours stay lines; no area is inferred from them. */
export function parseShakeMapContours(payload: unknown, url: string) {
  const data = payload as any;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("invalid_shakemap_contours");
  return buildFootprint(
    "shaking_intensity",
    url,
    data.features
      .filter(
        (f: any) =>
          f?.properties?.units === "mmi" &&
          Number.isFinite(f.properties.value) &&
          ["LineString", "MultiLineString"].includes(f.geometry?.type),
      )
      .map((f: any) => ({ geometry: f.geometry, level: f.properties.value })),
  );
}
