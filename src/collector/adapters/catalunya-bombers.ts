import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";

export const CATALUNYA_BOMBERS_PAGE =
  "https://interior.gencat.cat/ca/incendis-forestals/inici/index.html";
export const CATALUNYA_BOMBERS_LAYER =
  "https://services7.arcgis.com/ZCqVt1fRXwwK6GF4/arcgis/rest/services/ACTUACIONS_URGENTS_online_PRO_AMB_FASE_VIEW/FeatureServer/0";
export const CATALUNYA_BOMBERS_QUERY =
  CATALUNYA_BOMBERS_LAYER +
  "/query?" +
  new URLSearchParams({
    where: "1=1",
    outFields:
      "GlobalID,OBJECTID,ESRI_OID,ACT_IDE_ACTUACIO,ACT_DAT_ACTUACIO,TAL_DESC_ALARMA1,TAL_DESC_ALARMA2,ACT_SITUACIO,ACT_DAT_ACTUAL,ACT_DAT_INICI,ACT_DAT_FI,MUNICIPI_DPX,COM_FASE",
    orderByFields: "ACT_DAT_ACTUACIO DESC",
    resultRecordCount: "200",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });
const stamp = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** Public publisher-selected fire map, not private dispatch/radio or resource tracking.
 * Unknown status/phase codes are retained verbatim; absence of an end time never proves an active fire.
 */
export function parseCatalunyaBombers(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  const data = payload as any;
  if (!data || data.error || !Array.isArray(data.features))
    throw Error("invalid_bombers_response");
  if (data.exceededTransferLimit || data.features.length > 200)
    throw Error("bombers_pagination_required");
  const wgs84 = [
    data.spatialReference?.wkid,
    data.spatialReference?.latestWkid,
  ].includes(4326);
  return data.features.flatMap((feature: any) => {
    const a = feature.attributes ?? {};
    const id =
      text(a.GlobalID) ||
      (Number.isSafeInteger(a.OBJECTID) ? String(a.OBJECTID) : "");
    const municipality = text(a.MUNICIPI_DPX);
    const category = text(a.TAL_DESC_ALARMA2) || text(a.TAL_DESC_ALARMA1);
    const start = stamp(a.ACT_DAT_INICI) ?? stamp(a.ACT_DAT_ACTUACIO);
    if (!id || !municipality || !category || !start) return [];
    const updated = stamp(a.ACT_DAT_ACTUAL) ?? start;
    const end = stamp(a.ACT_DAT_FI);
    const g = feature.geometry;
    const hasPoint =
      wgs84 &&
      Number.isFinite(g?.x) &&
      Number.isFinite(g?.y) &&
      Math.abs(g.x) <= 180 &&
      Math.abs(g.y) <= 90;
    const title = `${category} — ${municipality}`;
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url: CATALUNYA_BOMBERS_PAGE,
        title,
        original_language: "ca",
        // The source supplies event/update clocks, not an article publication clock.
        published_at: null,
        source_updated_at: updated,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          {
            id: "public-fire-record",
            text: JSON.stringify({
              municipality,
              category,
              event_started_at: start,
              source_updated_at: updated,
              event_ended_at: end,
              source_status_code: text(a.ACT_SITUACIO) || null,
              source_phase: text(a.COM_FASE) || null,
              notice:
                "Official public vegetation-fire service record. Status codes are not decoded; no end timestamp does not confirm ongoing activity. No injuries, civilian impacts or evacuation instruction are supplied by this record.",
            }),
          },
        ],
        ...(hasPoint
          ? {
              source_geo: {
                lon: g.x,
                lat: g.y,
                name: municipality,
                accuracy: "point" as const,
              },
            }
          : {}),
        official: {
          issuer: "Generalitat de Catalunya — Bombers",
          effective_at: start,
          expires_at: end,
        },
        priority: 70,
      },
    ];
  });
}
