/**
 * Coverage and freshness per source and per sensor, derived from health the collector
 * already records. A quiet source read successfully and listed nothing; a stale one has
 * not been read successfully when it should have been. Neither says nothing happened.
 */
import type { IncidentView, ObservationInput, SourceRecord } from "./contracts";
import type { LayerSourceHealth, ThermalSensorHealth } from "./geospatial";

export type CoverageStatus =
  | "observed"
  | "quiet"
  | "stale"
  | "failing"
  | "ended"
  | "not_configured"
  | "access_unresolved";
/** Worst first, the order the coverage view lists them in. */
export const COVERAGE_ORDER: CoverageStatus[] = [
  "failing",
  "stale",
  "ended",
  "observed",
  "quiet",
  "access_unresolved",
  "not_configured",
];
/** Statuses of a source or sensor that is being read. */
export const COLLECTING: CoverageStatus[] = [
  "observed",
  "quiet",
  "stale",
  "failing",
];
/** The private collector and the local demo run every five minutes, so no source is read more often. */
export const COLLECTOR_CADENCE_SECONDS = 300;
/** Latency samples kept per source, and how far back they count. */
export const LAG_SAMPLES = 50;
export const LAG_WINDOW_SECONDS = 7 * 86400;
const RESUME_PENDING = "partial_fetch_accepted_resume_pending";

/** When a revision reached ingest and how many seconds after the issuer's own time on it. */
export type LagSample = [at: string, seconds: number];
export type SourceHealth = {
  checked_at?: string | null;
  last_success_at?: string | null;
  error?: string | null;
  checkpoint?: {
    accepted_items?: Record<string, string>;
    routing?: { ongoing: string[] };
    news_files?: string[];
    issuer_lag?: LagSample[];
  } | null;
};
export type Coverage = {
  status: CoverageStatus;
  /** Seconds between expected reads; a source is stale after two of them without a successful one. */
  expected_seconds: number;
  /** Records the source listed at its last complete read, when the checkpoint says. */
  records: number | null;
  /** A permission still pending for some use of a source that is otherwise read, from the registry. */
  unresolved: string | null;
};
export type Lag = { n: number; p50: number | null; p90: number | null };

const ageSeconds = (at: string | null | undefined, now: number) => {
  const ms = Date.parse(at ?? "");
  return Number.isFinite(ms) ? (now - ms) / 1000 : Infinity;
};
export const expectedSeconds = (
  source: Pick<SourceRecord, "poll_seconds">,
  cadence = COLLECTOR_CADENCE_SECONDS,
) => Math.max(source.poll_seconds || 0, cadence);

/** Open routing drops, recent GDELT files, otherwise the items the source still lists. */
function listedRecords(checkpoint: SourceHealth["checkpoint"]) {
  if (!checkpoint) return null;
  if (checkpoint.news_files) return checkpoint.news_files.length;
  if (checkpoint.routing) return checkpoint.routing.ongoing.length;
  return checkpoint.accepted_items
    ? Object.keys(checkpoint.accepted_items).length
    : null;
}

export function sourceCoverage(
  source: SourceRecord,
  health: SourceHealth | null | undefined,
  now = Date.now(),
  cadence = COLLECTOR_CADENCE_SECONDS,
): Coverage {
  const expected = expectedSeconds(source, cadence);
  const pending = source.config?.unresolved_permission;
  const coverage = (status: CoverageStatus): Coverage => ({
    status,
    expected_seconds: expected,
    records: listedRecords(health?.checkpoint),
    unresolved: typeof pending === "string" ? pending : null,
  });
  if (source.status === "license_required")
    return coverage("access_unresolved");
  if (
    !["enabled", "degraded"].includes(source.status) ||
    !source.rights.access ||
    !source.rights.storage ||
    !source.rights.display
  )
    return coverage("not_configured");
  // An error from a check long ago is not recent: the collector has stopped reading this source.
  if (ageSeconds(health?.checked_at, now) > 2 * expected)
    return coverage("stale");
  if (health?.error && health.error !== RESUME_PENDING)
    return coverage("failing");
  if (ageSeconds(health?.last_success_at, now) > 2 * expected)
    return coverage("stale");
  return coverage(
    listedRecords(health?.checkpoint) === 0 ? "quiet" : "observed",
  );
}

/** A geospatial layer or one of its sensors, judged against the catalogue's refresh cadence. */
export function layerCoverage(
  item: Pick<ThermalSensorHealth, "total_available"> & {
    status: ThermalSensorHealth["status"] | LayerSourceHealth["status"];
  },
  layer: Pick<LayerSourceHealth, "checked_at" | "cadence_seconds">,
  now = Date.now(),
): CoverageStatus {
  if (item.status === "ended") return "ended";
  if (ageSeconds(layer.checked_at, now) > 2 * layer.cadence_seconds)
    return "stale";
  if (item.status === "error") return "failing";
  return item.total_available ? "observed" : "quiet";
}

/**
 * Issuer time to ingest for new or changed records. A first read's backlog is history,
 * not latency, so a source without an earlier successful read gives no samples.
 */
export function issuerLag(
  records: Pick<ObservationInput, "published_at" | "source_updated_at">[],
  previousSuccess: string | null | undefined,
  now: number,
): LagSample[] {
  if (!Number.isFinite(Date.parse(previousSuccess ?? ""))) return [];
  const at = new Date(now).toISOString();
  return records.flatMap((r): LagSample[] => {
    const issued = Date.parse(r.source_updated_at ?? r.published_at ?? "");
    return Number.isFinite(issued)
      ? [[at, Math.max(0, Math.round((now - issued) / 1000))]]
      : [];
  });
}
/** The newest LAG_SAMPLES samples within LAG_WINDOW_SECONDS. */
export function keepLag(samples: LagSample[], now: number): LagSample[] {
  return samples
    .filter(([at]) => ageSeconds(at, now) <= LAG_WINDOW_SECONDS)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-LAG_SAMPLES);
}
/** Nearest-rank percentiles. */
export function summarise(seconds: number[]): Lag {
  const sorted = [...seconds].sort((a, b) => a - b);
  const rank = (q: number) =>
    sorted.length ? sorted[Math.ceil(q * sorted.length) - 1] : null;
  return { n: sorted.length, p50: rank(0.5), p90: rank(0.9) };
}
/**
 * Ingest to publication for the incidents a snapshot already holds, by their one source:
 * a structured record publishes in its ingest request, a narrative one when its analysis is accepted.
 */
export function publicationLag(
  incidents: Pick<IncidentView, "reports" | "ingested_at" | "analyzed_at">[],
  now: number,
) {
  const out = new Map<string, number[]>();
  for (const i of incidents) {
    const sources = new Set(i.reports.map((r) => r.source_id));
    const ingested = Date.parse(i.ingested_at);
    const published = i.analyzed_at ? Date.parse(i.analyzed_at) : ingested;
    if (
      sources.size !== 1 ||
      !Number.isFinite(ingested) ||
      !Number.isFinite(published) ||
      ageSeconds(i.ingested_at, now) > LAG_WINDOW_SECONDS
    )
      continue;
    const [id] = sources;
    out.set(id, [
      ...(out.get(id) ?? []),
      Math.max(0, Math.round((published - ingested) / 1000)),
    ]);
  }
  return out;
}
export function sourceLatency(
  health: SourceHealth | null | undefined,
  publication: number[] | undefined,
  now: number,
) {
  return {
    issuer_to_ingest: summarise(
      keepLag(health?.checkpoint?.issuer_lag ?? [], now).map(([, s]) => s),
    ),
    ingest_to_publication: summarise(publication ?? []),
  };
}
/** Sources that read a country, its own or worldwide; other countries' sources say nothing about it. */
export const coversCountry = (
  source: Pick<SourceRecord, "countries">,
  country: string,
) => source.countries.includes("*") || source.countries.includes(country);
