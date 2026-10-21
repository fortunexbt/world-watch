import {
  validEventTime,
  type ObservationInput,
  type SourceRecord,
} from "../../shared/contracts.js";
export const ZWAAILICHT_URL =
  "https://zwaailicht.nl/api/v1/incidents?service=brandweer&incident_type=fire&limit=30";
export function zwaailichtQueryURL(now: number) {
  const url = new URL(ZWAAILICHT_URL);
  url.searchParams.set("from", new Date(now - 86400000).toISOString());
  return url.href;
}
export function zwaailichtEligibleTitle(title: string) {
  const t = title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (
    /automatisch|brandmeldinstallatie|handmelder|\bbmi\b|oefening|proefalarm|nacontrole|reanimatie|onwel|patient|persoonsvermissing/.test(
      t,
    )
  )
    return false;
  return /brand|explosi|gevaarlijke stof|hazmat|evacuat|ontruim|\bgrip\b/.test(
    t,
  );
}
function ownPage(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, "https://zwaailicht.nl");
    return url.origin === "https://zwaailicht.nl" &&
      !url.username &&
      !url.password &&
      !url.pathname.startsWith("/api/")
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const time = (v: unknown) =>
  typeof v === "string" && validEventTime(v) && v.includes("T") ? v : null;
/** A bounded publisher-generated cluster feed, never raw radio, independent corroboration or proven on-scene facts. */
export function parseZwaailicht(
  source: SourceRecord,
  payload: unknown,
): ObservationInput[] {
  const data = payload as any;
  if (!data || !Array.isArray(data.results) || data.results.length > 30)
    throw Error("invalid_zwaailicht_response");
  if (
    data.license?.holder !== "Zwaailicht.nl" ||
    data.license?.terms !== "https://zwaailicht.nl/voorwaarden"
  )
    throw Error("zwaailicht_reuse_grant_missing");
  return data.results.flatMap((item: any) => {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const city =
      typeof item.location?.city === "string" ? item.location.city.trim() : "";
    const first = time(item.started_at);
    const page = ownPage(item._links?.html);
    if (!id || !title || !first || !page || item.type !== "incident") return [];
    return [
      {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url: page,
        title,
        original_language: "nl",
        published_at: null,
        // Last alarm is provenance freshness, not proof of the incident ending; count stays outside substantive evidence.
        source_updated_at: time(item.ended_at) ?? first,
        source_metadata: {
          publisher_generated: true,
          ...(Number.isSafeInteger(item.alert_count) && item.alert_count >= 0
            ? { alarm_count: item.alert_count }
            : {}),
        },
        input_coverage: "permitted_excerpt" as const,
        excerpts: [
          {
            id: "publisher-cluster",
            text: JSON.stringify({
              notice:
                "Publisher-generated interpretation of a public dispatch; raw pager message unavailable. Not confirmed incident. A publisher cluster is one source, not independent corroboration. Last-alarm/cluster-inactive status does not prove the incident ended.",
              publisher: "Zwaailicht.nl",
              title,
              city: city || null,
              country: "NL",
              first_dispatch_observed_at: first,
            }),
          },
        ],
        // Provider coordinates are deliberately omitted: actual Amsterdam-labelled input contained a distant point.
        // The host may resolve only the explicit source-named city using its own trusted gazetteer.
        priority: 80,
      },
    ];
  });
}
