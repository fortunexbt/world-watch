import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { polygonArea } from "./area.js";
import { buildFootprint } from "../../shared/footprint.js";

/** Warnings only. Advisories (fog, frost) and special weather statements outnumbered warnings by four to one on 22 October 2026. */
export const ECCC_ALERTS_URL =
  "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&alert_type=warning&limit=500";
/** ECCC's colour is its own impact rating; red is "very dangerous", which is still not stated mass casualties. */
export const ECCC_IMPACT = {
  yellow: "minor",
  orange: "significant",
  red: "severe",
} as const;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const stamp = (value: unknown): string | null => {
  const v = text(value);
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
};

/** ECCC weather alerts GeoJSON. One observation per warning per forecast region, as ECCC publishes them. */
export function parseEccc(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  const data = payload as any;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("invalid_eccc_response");
  if (data.numberMatched !== data.features.length)
    throw Error("eccc_pagination_required");
  return data.features.flatMap((feature: any) => {
    const p = feature?.properties ?? {};
    const id = text(feature?.id);
    const name = text(p.alert_name_en);
    const published = stamp(p.publication_datetime);
    const area = polygonArea(feature?.geometry);
    if (
      p.alert_type !== "warning" ||
      !/^\d+_[\w-]+$/.test(id) ||
      !name ||
      !published ||
      !area
    )
      return [];
    const colour = Object.hasOwn(ECCC_IMPACT, p.risk_colour_en)
      ? (p.risk_colour_en as keyof typeof ECCC_IMPACT)
      : null;
    const region = text(p.feature_name_en) || text(p.feature_id);
    const label = name[0].toUpperCase() + name.slice(1);
    const url =
      "https://api.weather.gc.ca/collections/weather-alerts/items/" + id;
    const footprint = buildFootprint("advisory_area", url, [
      { geometry: feature.geometry },
    ]);
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url: url,
        title: `${label}, ${region}`,
        original_language: "en",
        published_at: published,
        source_updated_at: published,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          {
            id: "eccc-alert",
            text: JSON.stringify({
              alert: name,
              alert_fr: text(p.alert_name_fr) || null,
              status: text(p.status_en) || null,
              risk_colour: colour,
              impact: text(p.impact_en) || null,
              confidence: text(p.confidence_en) || null,
              region,
              region_fr: text(p.feature_name_fr) || null,
              province: text(p.province) || null,
              issued: published,
              valid_from: stamp(p.validity_datetime),
              event_end: stamp(p.event_end_datetime),
              message_expires: stamp(p.expiration_datetime),
              text_en: text(p.alert_text_en) || null,
              text_fr: text(p.alert_text_fr) || null,
              notice:
                "Environment and Climate Change Canada warning, reproduced unchanged. The point is the centre of the forecast region the warning covers and the radius reaches its farthest vertex, so the circle is wider than the region. The colour is ECCC's own impact rating, not observed harm.",
            }),
          },
        ],
        source_geo: {
          ...area,
          name: region,
          accuracy: "area" as const,
          country: "CA",
        },
        ...(footprint ? { footprint } : {}),
        official: {
          issuer: "Environment and Climate Change Canada",
          effective_at: stamp(p.validity_datetime) ?? published,
          expires_at:
            stamp(p.event_end_datetime) ?? stamp(p.expiration_datetime),
          activity: /hurricane|tropical storm/i.test(name)
            ? ("tropical_cyclone" as const)
            : /storm surge/i.test(name)
              ? ("flood" as const)
              : ("severe_weather" as const),
          impact: colour ? ECCC_IMPACT[colour] : ("unknown" as const),
          cancelled: p.status_en === "ended",
        },
      },
    ];
  });
}
