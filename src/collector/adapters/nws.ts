import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { polygonArea } from "./area.js";

/**
 * Active storm-based warnings. NWS draws each of these as its own polygon, so no zone boundary has
 * to be fetched or guessed. Watches, advisories, statements and zone-only warnings are not queried,
 * and the status filter drops test, exercise and system messages.
 */
export const NWS_ALERTS_URL =
  "https://api.weather.gov/alerts/active?status=actual&event=Tornado%20Warning,Severe%20Thunderstorm%20Warning,Flash%20Flood%20Warning,Flood%20Warning,Extreme%20Wind%20Warning,Snow%20Squall%20Warning,Dust%20Storm%20Warning";
/** VTEC phenomenon codes of the queried warnings. */
const HAZARD = {
  TO: "severe_weather",
  SV: "severe_weather",
  EW: "severe_weather",
  SQ: "severe_weather",
  DS: "severe_weather",
  FF: "flood",
  FA: "flood",
  FL: "flood",
} as const;
/** CAP severity states a threat, not observed harm, so each level maps one step down and Extreme never becomes critical. */
export const NWS_IMPACT = {
  Minor: "informational",
  Moderate: "minor",
  Severe: "significant",
  Extreme: "severe",
} as const;
const STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);
const TERRITORIES = new Set(["PR", "GU", "AS", "VI", "MP"]);
const PARAMETERS = [
  "maxWindGust",
  "maxHailSize",
  "tornadoDetection",
  "tornadoDamageThreat",
  "thunderstormDamageThreat",
  "flashFloodDetection",
  "flashFloodDamageThreat",
];
const VTEC =
  /^\/O\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.W\.(\d{4})\.\d{6}T\d{4}Z-\d{6}T\d{4}Z\/$/;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const stamp = (value: unknown): string | null => {
  const v = text(value);
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
};

/** NWS active alerts GeoJSON. One observation per VTEC event; each NWS message is a revision of it. */
export function parseNws(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  const data = payload as any;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("invalid_nws_response");
  // The active list can repeat a message, so each event keeps only its latest one.
  const latest = new Map<string, ObservationInput>();
  for (const feature of data.features) {
    const p = feature?.properties ?? {};
    const identifier = text(p.id);
    const sent = stamp(p.sent);
    const vtec = (Array.isArray(p.parameters?.VTEC) ? p.parameters.VTEC : [])
      .map((v: unknown) => VTEC.exec(text(v)))
      .find((m: RegExpExecArray | null) => m && Object.hasOwn(HAZARD, m[3]));
    const area = polygonArea(feature?.geometry);
    if (
      p.status !== "Actual" ||
      !/^urn:oid:[\w.]+$/.test(identifier) ||
      !sent ||
      !vtec ||
      !area
    )
      continue;
    const [, action, office, phenomenon, etn] = vtec as RegExpExecArray;
    // The first message in the chain dates the warning; its year completes the identity because ETNs restart every January.
    const first = [
      sent,
      ...(Array.isArray(p.references) ? p.references : []).map((r: any) =>
        stamp(r?.sent),
      ),
    ]
      .filter((v): v is string => !!v)
      .sort()[0];
    const id = `${office}.${phenomenon}.W.${etn}.${first.slice(0, 4)}`;
    const prior = latest.get(id);
    if (prior && prior.source_updated_at! >= sent) continue;
    const countries = new Set<string | null>(
      (Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : []).map((u: unknown) => {
        const state = text(u).slice(0, 2);
        return STATES.has(state) ? "US" : TERRITORIES.has(state) ? state : null;
      }),
    );
    const severity = Object.hasOwn(NWS_IMPACT, p.severity)
      ? (p.severity as keyof typeof NWS_IMPACT)
      : null;
    const parameters = Object.fromEntries(
      PARAMETERS.flatMap((k) =>
        Array.isArray(p.parameters?.[k])
          ? [[k, p.parameters[k].join(", ")]]
          : [],
      ),
    );
    const event = text(p.event);
    latest.set(id, {
      source_id: source.id,
      native_id: id,
      source_event_id: id,
      canonical_url: "https://api.weather.gov/alerts/" + identifier,
      title: text(p.headline) || event,
      original_language: "en",
      published_at: sent,
      source_updated_at: sent,
      input_coverage: "full_licensed_text" as const,
      excerpts: [
        {
          id: "nws-alert",
          text: JSON.stringify({
            event,
            message_type: text(p.messageType) || null,
            vtec_action: action,
            vtec: vtec[0],
            severity,
            certainty: text(p.certainty) || null,
            urgency: text(p.urgency) || null,
            issuer: text(p.senderName) || null,
            area: text(p.areaDesc) || null,
            first_issued: first,
            sent,
            onset: stamp(p.onset),
            ends: stamp(p.ends),
            expires: stamp(p.expires),
            ...parameters,
            description: text(p.description) || null,
            instruction: text(p.instruction) || null,
            notice:
              "NOAA National Weather Service warning, reproduced unchanged. The point is the centre of the issuer's warning polygon and the radius reaches its farthest vertex, so the circle is wider than the warned area. Severity is the issuer's statement of threat, not observed harm.",
          }),
        },
      ],
      source_geo: {
        ...area,
        name: text(p.areaDesc) || event,
        accuracy: "area" as const,
        country: countries.size === 1 ? [...countries][0] : null,
      },
      official: {
        issuer: text(p.senderName) || "NOAA National Weather Service",
        effective_at: first,
        expires_at: stamp(p.ends) ?? stamp(p.expires),
        activity: HAZARD[phenomenon as keyof typeof HAZARD],
        impact: severity ? NWS_IMPACT[severity] : ("unknown" as const),
        cancelled: action === "CAN" || action === "UPG",
        message_type: text(p.messageType) || undefined,
      },
    });
  }
  return [...latest.values()];
}
