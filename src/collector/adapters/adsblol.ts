import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { countryAt } from "../../shared/borders.js";

/** All three emergency codes in one request, which keeps a five-minute poll inside ADSB.lol's 500 requests a day. */
export const ADSBLOL_SQUAWK_URL = "https://api.adsb.lol/v2/sqk/7500,7600,7700";
/**
 * The flight crew sets these codes, often in error or as a precaution, and no authority confirms them,
 * so impact stays low: unlawful interference is significant at most and never severe or critical.
 */
export const SQUAWK = {
  "7500": { meaning: "unlawful interference", impact: "significant" },
  "7600": { meaning: "radio failure", impact: "informational" },
  "7700": { meaning: "general emergency", impact: "minor" },
} as const;
/** readsb database flags for Privacy ICAO Address and FAA LADD aircraft, whose operators asked not to be tracked publicly. */
const PRIVACY_FLAGS = 4 | 8;
const HEX = /^~?[0-9a-f]{6}$/;
/** A fix older than one poll is too stale to map; readsb keeps lastPosition for as long as it tracks the aircraft. */
const MAX_FIX_AGE_S = 300;
/** Bounds an unknown ground speed at about an airliner's cruise. */
const FALLBACK_SPEED_KT = 500;
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";

/**
 * ADSB.lol aircraft currently squawking 7500, 7600 or 7700. One observation per aircraft and code;
 * an episode keeps the ID it was given when first seen while the previous complete read still
 * listed it, so the minute in the ID is its start and each later position is a revision.
 */
export function parseAdsbLol(
  source: SourceRecord,
  payload: unknown,
  active: Iterable<string> = [],
): ObservationInput[] {
  const data = payload as any;
  const now = number(data?.now);
  if (!Array.isArray(data?.ac) || now === null)
    throw Error("invalid_adsblol_response");
  if (data.total !== data.ac.length) throw Error("adsblol_response_truncated");
  const previous = [...active];
  const episodes = new Map<string, ObservationInput>();
  for (const a of data.ac) {
    const hex = text(a?.hex).toLowerCase();
    const code = text(a?.squawk);
    if (
      !HEX.test(hex) ||
      !Object.hasOwn(SQUAWK, code) ||
      (number(a.dbFlags) ?? 0) & PRIVACY_FLAGS
    )
      continue;
    const prefix = `${hex}.${code}.`;
    const id =
      previous.find(
        (v) =>
          v.startsWith(prefix) &&
          Number.isFinite(Date.parse(v.slice(prefix.length))),
      ) ?? prefix + minute(now);
    if (episodes.has(id)) continue;
    const started = new Date(id.slice(prefix.length)).toISOString();
    const { meaning, impact } = SQUAWK[code as keyof typeof SQUAWK];
    const callsign = text(a.flight) || null;
    const label = callsign ?? "Aircraft " + hex.toUpperCase();
    // readsb drops the live position after 60 seconds without one and keeps the last in lastPosition.
    const fix = number(a.lat) !== null ? a : a.lastPosition;
    const lat = number(fix?.lat),
      lon = number(fix?.lon),
      age = number(fix?.seen_pos) ?? 0;
    const located =
      lat !== null &&
      lon !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      age <= MAX_FIX_AGE_S;
    const speed = number(a.gs);
    episodes.set(id, {
      source_id: source.id,
      native_id: id,
      source_event_id: id,
      canonical_url: "https://adsb.lol/?icao=" + encodeURIComponent(hex),
      title: `${label} squawking ${code}, ${meaning}`,
      original_language: "en",
      published_at: null,
      source_updated_at: new Date(now).toISOString(),
      input_coverage: "full_licensed_text" as const,
      excerpts: [
        {
          id: "adsblol-aircraft",
          text: JSON.stringify({
            hex,
            callsign,
            squawk: code,
            squawk_meaning: meaning,
            emergency_status: text(a.emergency) || null,
            aircraft_type: text(a.t) || null,
            military: ((number(a.dbFlags) ?? 0) & 1) === 1,
            on_ground: a.alt_baro === "ground",
            altitude_ft: number(a.alt_baro),
            ground_speed_kt: speed,
            track_deg: number(a.track),
            vertical_rate_fpm: number(a.baro_rate),
            position_source:
              Array.isArray(a.mlat) && a.mlat.includes("lat")
                ? "mlat"
                : Array.isArray(a.tisb) && a.tisb.includes("lat")
                  ? "tisb"
                  : text(a.type) || null,
            position_at: located
              ? new Date(now - age * 1000).toISOString()
              : null,
            first_seen: started,
            notice:
              "Transponder code received by volunteer ADS-B receivers and relayed by ADSB.lol. The flight crew sets the code: 7700 declares a general emergency, 7600 a radio failure and 7500 unlawful interference. Codes are often set in error or as a precaution, and no authority has confirmed this one. The point is the last position received, at the stated time, and the aircraft has moved since. The episode ends when ADSB.lol stops listing the aircraft with this code, which can also mean it left receiver coverage. Contains information from ADSB.lol, made available under the Open Database License (ODbL) 1.0.",
          }),
        },
      ],
      ...(located
        ? {
            source_geo: {
              lon,
              lat,
              name: label + " reported position",
              accuracy: "point" as const,
              // Ground covered between the fix and the response, and at least a kilometre for multilateration error.
              radius_km: Math.max(
                1,
                Math.round(((speed ?? FALLBACK_SPEED_KT) * 1.852 * age) / 360) /
                  10,
              ),
              country: countryAt(lon, lat),
            },
          }
        : {}),
      official: {
        issuer: "ADSB.lol",
        effective_at: started,
        // A squawk states no validity; the episode lasts as long as ADSB.lol lists the aircraft with the code.
        expires_at: null,
        current_listing: true,
        self_reported: true,
        activity: "aviation_emergency" as const,
        impact,
      },
    });
  }
  return [...episodes.values()];
}
