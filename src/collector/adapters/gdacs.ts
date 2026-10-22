import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";

/** Orange and Red only. A Green-inclusive query returned exactly 100 events, mostly small wildfires, so an apparent page limit could silently drop a Red event. */
export const GDACS_EVENTS_URL =
  "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=Orange;Red";
const PAGE_LIMIT = 100;
/** Platform freshness rule, not a GDACS statement: a current event stays live for a day past its latest observation. */
const VALIDITY_MS = 24 * 3600000;
const HAZARD = {
  EQ: "earthquake",
  TC: "tropical_cyclone",
  FL: "flood",
  VO: "volcanic_eruption",
  DR: "drought",
  WF: "wildfire",
} as const;
/** GDACS alert levels estimate humanitarian impact from models, not stated harm, so Red never becomes critical. */
export const GDACS_IMPACT = {
  Green: "minor",
  Orange: "significant",
  Red: "severe",
} as const;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
/** GDACS writes UTC clock times without a zone designator. */
const utc = (value: unknown): string | null => {
  const v = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(
      v,
    )
  )
    return null;
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(v) ? v : v + "Z");
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** GDACS event list. One observation per event; the episode is its native revision. */
export function parseGdacs(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  const data = payload as any;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("invalid_gdacs_response");
  if (data.features.length >= PAGE_LIMIT)
    throw Error("gdacs_pagination_required");
  return data.features.flatMap((feature: any) => {
    const p = feature?.properties ?? {};
    const type = text(p.eventtype) as keyof typeof HAZARD;
    const eventId = Number.isSafeInteger(p.eventid) ? p.eventid : null;
    const episodeId = Number.isSafeInteger(p.episodeid) ? p.episodeid : null;
    const from = utc(p.fromdate);
    if (!Object.hasOwn(HAZARD, type) || eventId === null || !from) return [];
    // Orange and Red results include archived events; only current ones belong on the live map.
    if (p.iscurrent !== "true") return [];
    const to = utc(p.todate);
    const modified = utc(p.datemodified) ?? from;
    const level = Object.hasOwn(GDACS_IMPACT, p.alertlevel)
      ? (p.alertlevel as keyof typeof GDACS_IMPACT)
      : null;
    const affected: string[] = (
      Array.isArray(p.affectedcountries) ? p.affectedcountries : []
    )
      .map((c: any) => text(c?.iso2).toUpperCase())
      .filter((c: string) => /^[A-Z]{2}$/.test(c));
    const [lon, lat] = Array.isArray(feature.geometry?.coordinates)
      ? feature.geometry.coordinates
      : [];
    const hasPoint =
      feature.geometry?.type === "Point" &&
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90;
    const id = `${type}-${eventId}`;
    const name = text(p.name) || text(p.description) || id;
    const upstream = text(p.source) || null;
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url:
          "https://www.gdacs.org/report.aspx?" +
          new URLSearchParams({
            eventid: String(eventId),
            ...(episodeId === null ? {} : { episodeid: String(episodeId) }),
            eventtype: type,
          }),
        title: name,
        original_language: "en",
        published_at: null,
        source_updated_at: modified,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          {
            id: "gdacs-event",
            text: JSON.stringify({
              hazard_type: type,
              event_name: text(p.eventname) || null,
              alert_level: level,
              alert_score: Number.isFinite(p.alertscore) ? p.alertscore : null,
              episode_id: episodeId,
              episode_alert_level: text(p.episodealertlevel) || null,
              severity: text(p.severitydata?.severitytext) || null,
              from,
              to,
              source_updated_at: modified,
              countries: text(p.country) || null,
              affected_countries: affected,
              glide: text(p.glide) || null,
              hazard_data_source: upstream,
              notice: `GDACS automatic alert, provided as is and not for decision making without confirmation. The point is a GDACS centroid, not an impact footprint. The alert level is the event maximum across episodes and a modelled humanitarian-impact estimate, not observed harm. World Watch keeps the event live until 24 hours after the latest GDACS observation; each GDACS update extends it. Hazard data originates from ${upstream ?? "an unstated provider"} and is third-party material outside the GDACS licence.`,
            }),
          },
        ],
        ...(hasPoint
          ? {
              source_geo: {
                lon,
                lat,
                name: text(p.country) || name,
                accuracy: "area" as const,
                country: affected.length === 1 ? affected[0] : null,
              },
            }
          : {}),
        official: {
          issuer: "GDACS — European Commission Joint Research Centre",
          effective_at: from,
          expires_at: to
            ? new Date(Date.parse(to) + VALIDITY_MS).toISOString()
            : null,
          activity: HAZARD[type],
          impact: level ? GDACS_IMPACT[level] : ("unknown" as const),
        },
      },
    ];
  });
}
