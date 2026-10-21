import {
  validEventTime,
  type ObservationInput,
  type SourceRecord,
} from "../../shared/contracts.js";
export const IDMC_UKRAINE_URL =
  "https://data.humdata.org/dataset/52880c3a-715d-4e01-b75a-1fc3f64babf6/resource/ee65f9fe-f1c7-4466-9f83-620b50eccdc6/download/ukr_idmc_idu_events.csv";
export const IDMC_UKRAINE_PAGE =
  "https://data.humdata.org/dataset/ukr-idmc-idu-events";
export const IDMC_LICENSE = "https://creativecommons.org/licenses/by/3.0/igo/";
/** Bounded RFC4180 reader, including quoted commas/newlines and escaped quotes. Never evaluates formulae. */
function csv(text: string): string[][] {
  if (text.length > 2 * 1024 * 1024) throw Error("idmc_size_limit");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === '"') {
      if (field || closed) throw Error("invalid_idmc_csv_quote");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw Error("invalid_idmc_csv_quote");
      field += c;
    }
    if (rows.length > 5000 || field.length > 50000 || row.length > 60)
      throw Error("idmc_csv_budget");
  }
  if (quoted) throw Error("invalid_idmc_csv_quote");
  if (field || row.length) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}
const text = (v: unknown, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const date = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && validEventTime(v)
    ? v
    : null;
function stamp(v: unknown) {
  if (typeof v !== "string") return null;
  const n = v.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, "$1");
  return n.includes("T") &&
    validEventTime(n) &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(n)
    ? new Date(n).toISOString()
    : null;
}
function reference(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
/** Daily provisional displacement flows, not live tracking, total population or independent corroboration. */
export function parseIdmcUkraine(
  source: SourceRecord,
  body: string,
  now = Date.now(),
): ObservationInput[] {
  const rows = csv(body),
    header = rows.shift();
  if (
    !header ||
    [
      "id",
      "iso3",
      "figure",
      "qualifier",
      "displacement_type",
      "displacement_date",
      "locations_name",
      "locations_accuracy",
      "created_at",
    ].some((h) => !header.includes(h)) ||
    new Set(header).size !== header.length
  )
    throw Error("invalid_idmc_headers");
  const valid = rows
    .map((values) => {
      if (values.length !== header.length) throw Error("invalid_idmc_row");
      return Object.fromEntries(header.map((h, i) => [h, values[i]]));
    })
    .filter((r) => {
      const d = date(r.displacement_end_date) || date(r.displacement_date);
      return (
        /^\d+$/.test(r.id) &&
        r.iso3 === "UKR" &&
        d !== null &&
        Date.parse(d) >= now - 14 * 86400000 &&
        Date.parse(d) <= now &&
        /^\d+(?:\.\d+)?$/.test(r.figure) &&
        Number.isFinite(Number(r.figure)) &&
        Number(r.figure) >= 0
      );
    })
    .sort(
      (a, b) =>
        (date(b.displacement_end_date) || b.displacement_date).localeCompare(
          date(a.displacement_end_date) || a.displacement_date,
        ) ||
        (b.created_at || "").localeCompare(a.created_at || "") ||
        a.id.localeCompare(b.id),
    );
  const byId = new Map<string, (typeof valid)[number]>();
  for (const record of valid)
    if (!byId.has(record.id)) byId.set(record.id, record);
  const unique = [...byId.values()].slice(0, 30);
  return unique.map((r) => {
    const start = date(r.displacement_start_date) || date(r.displacement_date),
      end = date(r.displacement_end_date) || date(r.displacement_date);
    const names = text(r.locations_name, 700),
      type = text(r.displacement_type, 40),
      qualifier = text(r.qualifier, 60),
      figure = Number(r.figure);
    const title = `Ukraine: ${qualifier} ${figure} reported ${type.toLowerCase()} displacements — ${end}`;
    return {
      source_id: source.id,
      native_id: r.id,
      source_event_id: r.id,
      canonical_url: IDMC_UKRAINE_PAGE,
      title,
      original_language: "en",
      published_at: null,
      source_updated_at: null,
      input_coverage: "permitted_excerpt" as const,
      excerpts: [
        {
          id: "licensed-flow-metadata",
          text: JSON.stringify({
            record_id: r.id,
            upstream_event_id: text(r.event_id, 40) || null,
            displacement_type: type,
            qualifier,
            figure,
            figure_role: text(r.role, 100) || null,
            displacement_started_on: start,
            displacement_ended_on: end,
            source_record_created_at: stamp(r.created_at),
            locations: names || null,
            locations_truncated: r.locations_name.length > 700,
            location_accuracy: text(r.locations_accuracy, 300) || null,
            location_role: text(r.locations_type, 100) || null,
            event_name: text(r.event_name, 250) || null,
            reported_cause: text(r.subtype || r.type, 150) || null,
            source_publishers: text(r.sources, 250) || null,
            upstream_reference: reference(r.source_url || r.link || ""),
            notice:
              "IDMC daily provisional reported displacement FLOW estimate. Not live movement, a cumulative population total or independently confirmed headcount. Estimates can overlap or be revised: do not sum records without IDMC preprocessing. Dates retain day precision. Multiple locations are not one precise incident point; supplied aggregate centroids are intentionally omitted. Record creation time is not event time or original article publication.",
            attribution:
              "Internal Displacement Monitoring Centre (IDMC), Internal Displacement Updates, via HDX — CC BY-IGO 3.0. Derived compact factual metadata; changes/analysis indicated. " +
              IDMC_UKRAINE_PAGE +
              " — " +
              IDMC_LICENSE,
          }),
        },
      ],
      priority: 35,
    };
  });
}
