import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { validEventTime } from "../../shared/contracts.js";
export const DEMOS_QUERY_URL = "https://api.demonstrations.org/v1/event/all";
export const DEMOS_READ_QUERY = {
  sorting_key: "created",
  sorting_direction: "desc",
  offset: 0,
  limit: 20,
} as const;
export const DEMOS_LICENSE_URL =
  "https://creativecommons.org/licenses/by-sa/4.0/";
const field = (v: unknown, max = 300) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
function timestamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // API timestamps use microseconds; shared wire dates preserve milliseconds.
  const normalized = v.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, "$1");
  return normalized.includes("T") &&
    validEventTime(normalized) &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    ? new Date(normalized).toISOString()
    : null;
}
function wallTime(v: unknown): string | null {
  return typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v) &&
    validEventTime(v + "Z")
    ? v
    : null;
}
function timezone(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 80) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return v;
  } catch {
    return null;
  }
}
function upstream(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
/** Public licensed aggregator facts, not an upstream article, surveyed geometry or independent confirmation. */
export function parseDemos(
  source: SourceRecord,
  value: unknown,
): ObservationInput[] {
  const data = value as any;
  if (!data || !Array.isArray(data.events) || data.events.length > 20)
    throw Error("invalid_demos_page");
  return data.events.flatMap((event: any) => {
    if (
      !event ||
      !Number.isSafeInteger(event.id) ||
      event.id <= 0 ||
      event.rights_restricted === true ||
      event.reuse_allowed === false ||
      event.license_restricted === true ||
      event.rights?.restricted === true ||
      event.rights?.reuse_allowed === false ||
      event.license?.restricted === true ||
      /all rights reserved|rights restricted/i.test(
        typeof event.license === "string" ? event.license : "",
      )
    )
      return [];
    const title = field(event.name),
      slug = field(event.slug, 500),
      start = wallTime(event.start_time),
      end = wallTime(event.end_time),
      tz = timezone(event.timezone);
    if (
      !title ||
      !/^\d+--[A-Za-z0-9_-]*$/.test(slug) ||
      !slug.startsWith(event.id + "--") ||
      !start
    )
      return [];
    const locations = (Array.isArray(event.locations) ? event.locations : [])
      .slice(0, 8)
      .map((p: any) => ({
        country: field(p?.country, 80) || null,
        city: field(p?.city, 120) || null,
        street: field(p?.street, 200) || null,
        sequence: Number.isSafeInteger(p?.sequence) ? p.sequence : null,
      }))
      .filter((p: any) => p.city || p.street);
    const publisherGenerated = event.is_llm_parsed === true;
    const canonical = "https://demonstrations.org/en/events/" + slug;
    return [
      {
        source_id: source.id,
        native_id: String(event.id),
        source_event_id: String(event.id),
        canonical_url: canonical,
        title,
        original_language: "de",
        published_at: null,
        source_updated_at: timestamp(event.updated),
        input_coverage: "permitted_excerpt" as const,
        source_metadata: { publisher_generated: publisherGenerated },
        excerpts: [
          {
            id: "licensed-event-metadata",
            text: JSON.stringify({
              event_title: title,
              event_start_local: start,
              event_end_local: end,
              timezone: tz,
              aggregator_record_created_at: timestamp(event.created),
              aggregator_record_updated_at: timestamp(event.updated),
              public_locations: locations,
              public_location_count: Array.isArray(event.locations)
                ? event.locations.length
                : 0,
              public_locations_omitted: Array.isArray(event.locations)
                ? Math.max(0, event.locations.length - 8)
                : 0,
              raw_public_location: field(event.raw_location, 1000) || null,
              raw_public_location_truncated:
                typeof event.raw_location === "string" &&
                event.raw_location.trim().length > 1000,
              upstream_reference: upstream(event.url),
              publisher_generated: publisherGenerated,
              notice:
                "Demos Berlin e.V. licensed aggregator-extracted event facts; not independently confirmed. Planned assembly is not confirmed attendance or violence. Coordinates/routes and upstream article text are intentionally not reproduced; no surveyed location is asserted. Times are source-local wall times; missing timezone remains unknown.",
              attribution:
                "Demos Berlin e.V. — CC BY-SA 4.0. Derived factual event metadata; changes/analysis indicated. " +
                canonical +
                " — " +
                DEMOS_LICENSE_URL,
            }),
          },
        ],
        priority: 90,
      },
    ];
  });
}
