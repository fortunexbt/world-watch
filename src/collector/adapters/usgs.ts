import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { countryAt } from "../../shared/borders.js";

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
