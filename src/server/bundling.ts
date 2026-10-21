import {
  validEventTime,
  type ObservationInput,
  type SourceRecord,
} from "../shared/contracts.js";

const normalize = (text: string) =>
  text.normalize("NFC").replace(/\s+/gu, " ").trim();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return typeof value === "string" ? normalize(value) : value;
}
function day(value: string | null | undefined) {
  return value && validEventTime(value)
    ? new Date(value).toISOString().slice(0, 10)
    : null;
}
function hasNativeReference(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 12) return false;
  return Object.entries(value).some(([key, item]) =>
    /^(?:StopPointRef|VehicleJourneyRef|LineRef|RouteRef)$/.test(key)
      ? (typeof item === "string" || typeof item === "number") &&
        String(item).trim().length > 0
      : hasNativeReference(item, depth + 1),
  );
}
function siriAnchor(input: ObservationInput, source: SourceRecord) {
  if (source.family !== "siri") return false;
  const affects = input.excerpts.some((e) => {
    try {
      return hasNativeReference(JSON.parse(e.text));
    } catch {
      return false;
    }
  });
  const validity = input.excerpts.some((e) => {
    const m = e.text.match(/^Start:\s*([^;]+);\s*End:\s*([^;]+);/);
    return m && validEventTime(m[1].trim()) && validEventTime(m[2].trim());
  });
  return affects && validity;
}

/** Exact-content reuse only. Null means use the report's own identity, never a shared unknown-date bucket.
 * Callers must recheck current rights and validate/remap each report's evidence IDs before reusing analysis.
 * This function neither clusters similar reports nor establishes cross-source corroboration.
 */
export function stableBundlePayload(
  input: ObservationInput,
  source: SourceRecord,
): string | null {
  if (
    source.id !== input.source_id ||
    !source.rights.access ||
    !source.rights.storage ||
    !source.rights.ai ||
    !["enabled", "degraded"].includes(source.status) ||
    input.eligibility?.eligible === false
  )
    return null;
  const anchored =
    !!input.source_event_id?.trim() ||
    (!!input.source_geo &&
      !!(
        day(input.official?.effective_at) ?? day(input.official?.expires_at)
      )) ||
    siriAnchor(input, source);
  if (!anchored) return null;
  const nativeEpisode = !!input.source_event_id?.trim();
  const datedNativeEvidence =
    nativeEpisode &&
    input.excerpts.some((e) =>
      [...e.text.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gu)].some((m) =>
        validEventTime(m[0]),
      ),
    );
  const sourceDay =
    day(input.published_at) ??
    day(input.official?.effective_at) ??
    day(input.official?.expires_at) ??
    (nativeEpisode ? null : day(input.source_updated_at));
  if (
    (!sourceDay && !datedNativeEvidence) ||
    !input.original_language.trim() ||
    input.input_coverage === "title_only"
  )
    return null;
  const title = normalize(input.title);
  const excerpts = [
    ...new Set(
      input.excerpts
        .map((e) => normalize(e.text))
        .filter((text) => text && text !== title),
    ),
  ];
  // A generic heading plus machine validity timestamps is not enough evidence to share an analysis.
  const substantive = excerpts
    .filter((text) => !/^(?:Start:|Area:|Expires:|Effective:)/i.test(text))
    .join(" ");
  if (substantive.length < 80 || substantive.split(" ").length < 8) return null;
  let origin: string;
  try {
    origin = new URL(source.url).origin;
  } catch {
    return null;
  }
  return JSON.stringify(
    canonical({
      version: "exact-content-1",
      source_id: source.id,
      publisher_origin: origin,
      source_day: sourceDay,
      published_day: day(input.published_at),
      language: input.original_language.trim().toLowerCase(),
      coverage: input.input_coverage,
      title,
      excerpts,
      geography: input.source_geo ?? null,
      official: input.official ?? null,
      source_event_id: input.source_event_id ?? null,
    }),
  );
}
