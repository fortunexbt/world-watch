import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { mainland } from "../../shared/borders.js";
import countryNames from "../../shared/countries.json";
import { csv } from "../csv.js";
import { polygonArea } from "./area.js";

/** The bulletin list's JSON export: EASA's node ID, status, issue and update times, without the text. */
export const EASA_CZIB_URL =
  "https://www.easa.europa.eu/en/domains/air-operations/czibs/export-json?page&_format=json";
/** The CSV export of the same list with each bulletin's full text. */
export const EASA_CZIB_TEXT_URL =
  "https://www.easa.europa.eu/en/domains/air-operations/czibs/export?page&_format=csv";
const COLUMNS = [
  "Subject",
  "CZIB number",
  "Issue date",
  "Valid until",
  "Valid until description",
  "Status",
  "Revision",
  "Affected Airspace",
  "Affected Country",
  "Applicability",
  "Applicability description",
  "Description",
  "Recommendation(s)",
  "Referenced publication(s)",
];
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const entities = (value: string) =>
  value
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const stamp = (value: unknown): string | null => {
  const v = text(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
};
/** EASA states dates as DD/MM/YYYY. */
const day = (value: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const byName = new Map<string, string>(
  countryNames.flatMap((c) =>
    [c.name, ...c.aliases].map((n) => [n.toLowerCase(), c.country]),
  ),
);
/** A country too small for the map's 1:110m borders, such as Bahrain, adds a square around its gazetteer centre and radius. */
function countryPolygon(code: string) {
  const outline = mainland(code);
  if (outline) return outline;
  const c = countryNames.find((v) => v.country === code)!;
  const dy = c.radius_km / 111.32,
    dx = dy / Math.cos((c.lat * Math.PI) / 180);
  return [
    [
      [c.lon - dx, c.lat - dy],
      [c.lon + dx, c.lat - dy],
      [c.lon + dx, c.lat + dy],
      [c.lon - dx, c.lat + dy],
      [c.lon - dx, c.lat - dy],
    ],
  ];
}

/**
 * EASA Conflict Zone Information Bulletins. The JSON list and the CSV export describe the same
 * bulletins and are joined by subject and issue date; a bulletin missing from either fails the
 * read rather than publishing without its text. EASA's node ID stays the same across revisions,
 * so each revision updates one record, and a withdrawn bulletin ends as cancelled.
 */
export function parseEasaCzibs(
  source: SourceRecord,
  payload: unknown,
  body: string,
): ObservationInput[] {
  const list = (payload as any)?.conflict_zones;
  const [header, ...rows] = csv(body);
  if (
    !Array.isArray(list) ||
    !header ||
    COLUMNS.some((c, i) => header[i] !== c)
  )
    throw Error("invalid_easa_czib_export");
  const bulletins = new Map(
    rows.map((r) => [
      `${r[0].trim()}|${day(r[2])}`,
      Object.fromEntries(COLUMNS.map((c, i) => [c, text(r[i])])),
    ]),
  );
  if (bulletins.size !== list.length) throw Error("easa_czib_exports_disagree");
  return list.flatMap((item: any) => {
    const id = text(item?.Nid);
    const issued = stamp(item?.issued_date);
    const b = bulletins.get(
      `${entities(text(item?.name))}|${text(item?.issued_date).slice(0, 10)}`,
    );
    if (!b) throw Error("easa_czib_exports_disagree");
    const status = b.Status;
    if (
      !/^\d+$/.test(id) ||
      !issued ||
      !["Active", "Withdrawn"].includes(status)
    )
      return [];
    const updated =
      stamp(/datetime="([^"]+)"/.exec(text(item.updated))?.[1]) ?? issued;
    const until = day(b["Valid until"]);
    const names = b["Affected Country"]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const codes = names.map((n) => byName.get(n.toLowerCase()) ?? null);
    const area =
      codes.length && codes.every((c) => c)
        ? polygonArea({
            type: "MultiPolygon",
            coordinates: (codes as string[]).map(countryPolygon),
          })
        : null;
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url: "https://www.easa.europa.eu/en/node/" + id,
        title: `EASA conflict zone bulletin ${b["CZIB number"]}: ${b.Subject}`,
        original_language: "en",
        published_at: updated,
        source_updated_at: updated,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          {
            id: "easa-czib",
            text: JSON.stringify({
              czib_number: b["CZIB number"],
              subject: b.Subject,
              status,
              issued: day(b["Issue date"]),
              revision: b.Revision || null,
              valid_until: until,
              valid_until_description: b["Valid until description"] || null,
              affected_airspace: b["Affected Airspace"] || null,
              affected_countries: b["Affected Country"] || null,
              country_codes: codes.every((c) => c) ? codes : null,
              applicability: b.Applicability || null,
              applicability_description: b["Applicability description"] || null,
              description: b.Description || null,
              recommendations: b["Recommendation(s)"] || null,
              referenced_publications: b["Referenced publication(s)"] || null,
              updated,
              notice:
                "European Union Aviation Safety Agency Conflict Zone Information Bulletin, reproduced unchanged with the source acknowledged. It shares information and recommendations for air operators about risk to civil aviation from a conflict zone and reports no harm. The circle covers the whole of each affected country's largest landmass; the affected airspace EASA describes can be part of it. EASA states a validity date without a time, so World Watch ends the bulletin at the close of that date in UTC.",
            }),
          },
        ],
        ...(area
          ? {
              source_geo: {
                ...area,
                name: names.join(", "),
                accuracy:
                  codes.length === 1 ? ("country" as const) : ("area" as const),
                country: codes.length === 1 ? codes[0] : null,
              },
            }
          : {}),
        official: {
          issuer: "European Union Aviation Safety Agency",
          effective_at: issued,
          expires_at: until ? until + "T23:59:59Z" : null,
          activity: "conflict_zone_advisory" as const,
          impact: "significant" as const,
          cancelled: status === "Withdrawn",
        },
      },
    ];
  });
}
