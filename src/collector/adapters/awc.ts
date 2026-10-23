import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { countryAt } from "../../shared/borders.js";
import { polygonArea } from "./area.js";

/**
 * Current volcanic ash SIGMETs worldwide from the Aviation Weather Center's data API. JSON, unlike
 * GeoJSON, carries AWC's receipt time, and it answers 204 No Content when no ash SIGMET is valid.
 * Thunderstorm, turbulence and icing SIGMETs are routine flight hazards, and tropical cyclone
 * SIGMETs repeat what GDACS already maps, so they are not queried.
 */
export const AWC_SIGMET_URL =
  "https://aviationweather.gov/api/data/sigmet?format=json&hazard=va";
/** AWC caps most endpoints at 400 entries, so a full list could hide SIGMETs. */
export const AWC_LIMIT = 400;
/** Meteorological watch offices of the US National Weather Service, whose SIGMETs are U.S. public domain. */
export const US_WATCH_OFFICES = ["KKCI", "PAWU", "PHFO"];
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const stamp = (value: unknown): string | null => {
  const v = text(value);
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
};
const epoch = (value: unknown) =>
  Number.isFinite(value)
    ? new Date((value as number) * 1000).toISOString()
    : null;
const level = (feet: unknown) =>
  !Number.isFinite(feet)
    ? null
    : feet === 0
      ? "SFC"
      : "FL" + String(Math.round((feet as number) / 100)).padStart(3, "0");
/** AWC writes longitudes past 180° for areas that cross the antimeridian. */
const ring = (points: unknown) =>
  Array.isArray(points)
    ? points.map((p: any) => [
        Math.abs(p?.lon) > 180 ? ((p.lon + 540) % 360) - 180 : p?.lon,
        p?.lat,
      ])
    : [];

/**
 * One record per SIGMET. AWC lists a SIGMET's observed and forecast ash clouds as two entries with
 * the same message (series "2" and "2F"), so entries are grouped by issuing office, the series the
 * message itself states and its validity start, and the area covers both clouds. Series numbers
 * restart each day, so the validity start completes the identity. Each SIGMET is its own record:
 * a replacement for the same volcano gets a new series number and a new record.
 */
export function parseAwcSigmets(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  if (!Array.isArray(payload)) throw Error("invalid_awc_response");
  if (payload.length >= AWC_LIMIT) throw Error("awc_sigmet_list_truncated");
  const groups = new Map<string, { series: string; parts: any[] }>();
  for (const entry of payload) {
    const raw = text(entry?.rawSigmet);
    const office = text(entry?.icaoId);
    const from = epoch(entry?.validTimeFrom);
    // A SIGMET drawn as a line has no area to map, so it is left out.
    if (
      entry?.hazard !== "VA" ||
      !["AREA", "AREAS"].includes(entry.geom) ||
      !raw ||
      !/^[A-Z]{4}$/.test(office) ||
      !from
    )
      continue;
    const series =
      /\bSIGMET\s+(.+?)\s+VALID\b/.exec(raw.replace(/\s+/g, " "))?.[1] ??
      text(entry.seriesId);
    const id = `${office}-${series.replace(/\s+/g, "")}-${from.slice(0, 16).replace(/[-:]/g, "")}`;
    const group = groups.get(id) ?? { series, parts: [] };
    group.parts.push(entry);
    groups.set(id, group);
  }
  return [...groups].flatMap(([id, { series, parts }]) => {
    const first = parts[0];
    const area = polygonArea({
      type: "MultiPolygon",
      coordinates: parts.flatMap((p) =>
        p.geom === "AREA"
          ? [[ring(p.coords)]]
          : Array.isArray(p.coords)
            ? p.coords.map((c: unknown) => [ring(c)])
            : [],
      ),
    });
    const received = parts
      .map((p) => stamp(p.receiptTime))
      .filter((v): v is string => !!v)
      .sort()[0];
    if (!area || !received) return [];
    const raw = text(first.rawSigmet);
    const flat = raw.replace(/\s+/g, " ");
    const office = text(first.icaoId);
    const fir = text(first.firName) || text(first.firId);
    const volcano =
      /\bVA (?:ERUPTION )?(?:MT )?(?:VOLCAN )?([A-Z][A-Z0-9 /.'()-]*?) PSN\b/.exec(
        flat,
      )?.[1] ?? null;
    const base = parts.map((p) => p.base).find(Number.isFinite) ?? null;
    const top = parts.map((p) => p.top).find(Number.isFinite) ?? null;
    const validFrom = epoch(first.validTimeFrom)!;
    const validTo = epoch(first.validTimeTo);
    const name = volcano ? `${volcano}, ${fir}` : fir;
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url:
          "https://aviationweather.gov/api/data/sigmet?format=raw&hazard=va&date=" +
          validFrom.slice(0, 16).replace(/[-:]/g, "").replace("T", "_"),
        title: `Volcanic ash SIGMET ${series} from ${office}: ${name}`,
        original_language: "en",
        published_at: received,
        source_updated_at: received,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          {
            id: "awc-sigmet",
            text: JSON.stringify({
              hazard: "volcanic ash",
              issuing_office: office,
              // SIGMETs from NWS offices are U.S. public domain; others are the issuing state's.
              public_domain: US_WATCH_OFFICES.includes(office),
              flight_information_region: fir || null,
              series,
              volcano,
              parts: parts.map((p) => text(p.sigmetType) || null),
              issued: stamp(first.issueTime),
              received,
              valid_from: validFrom,
              valid_to: validTo,
              base_feet: base,
              top_feet: top,
              levels:
                base === null || top === null
                  ? null
                  : `${level(base)}/${level(top)}`,
              movement:
                text(first.dir) && Number.isFinite(first.spd)
                  ? `${text(first.dir)} ${first.spd} kt`
                  : null,
              change: text(first.chng) || null,
              sigmet: raw,
              notice:
                "SIGMET relayed by the NOAA Aviation Weather Center from the meteorological watch office that issued it, reproduced unchanged. It warns aircraft of a volcanic ash cloud between the stated levels until its stated end. The point is the centre of the observed and forecast ash areas and the radius reaches their farthest vertex, so the circle is wider than the warned airspace. Base and top are in feet; in the level band, FL is hundreds of feet and SFC the surface. A SIGMET states no ash concentration and no harm on the ground, and the volcano's eruption itself is a separate record. The issuing office's cancellation messages are not in AWC's decoded feed, so a SIGMET cancelled early stays until its stated end.",
            }),
          },
        ],
        source_geo: {
          ...area,
          name,
          accuracy: "area" as const,
          // The issuing state's FIR can extend over the sea or a neighbour; the country comes from the area's centre.
          country: countryAt(area.lon, area.lat),
        },
        official: {
          issuer: `Meteorological watch office ${office}, relayed by the NOAA Aviation Weather Center`,
          effective_at: validFrom,
          expires_at: validTo,
          activity: "volcanic_ash" as const,
          impact: "minor" as const,
        },
      },
    ];
  });
}
