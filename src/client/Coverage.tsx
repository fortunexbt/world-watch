import { ArrowUpRight } from "lucide-react";
import type { IncidentView } from "../shared/contracts";
import {
  COLLECTING,
  COVERAGE_ORDER,
  coversCountry,
  layerCoverage,
  publicationLag,
  sourceCoverage,
  sourceLatency,
  type CoverageStatus,
  type Lag,
} from "../shared/coverage";
import type {
  GeospatialCatalog,
  LayerSourceHealth,
} from "../shared/geospatial";
import { SNAPSHOT_CADENCE_SECONDS } from "../shared/public-snapshot";
import { translate, type Language } from "./locale";
import { formatAge } from "./time";

const LABEL: Record<CoverageStatus, string> = {
  observed: "Observed",
  quiet: "Quiet",
  stale: "Stale",
  failing: "Failing",
  ended: "Ended",
  not_configured: "Not configured",
  access_unresolved: "Access unresolved",
};
const MEANING: Record<CoverageStatus, string> = {
  observed: "Read on schedule and listing records.",
  quiet: "Read on schedule and listing nothing.",
  stale: "No successful read within two expected intervals.",
  failing: "The latest read failed.",
  ended: "The issuer stopped delivering this data.",
  not_configured: "Not read: disabled or awaiting credentials.",
  access_unresolved: "A licence or permission is not settled yet.",
};
const LAYER_LABEL: Record<LayerSourceHealth["id"], string> = {
  firms: "Satellite thermal detections",
  copernicus: "Copernicus mapping areas",
  gnss: "GNSS interference grid",
};
/** The public demo reads every source once per snapshot run. */
const cadence = __PUBLIC_DEMO__ ? SNAPSHOT_CADENCE_SECONDS : undefined;
const coverageOf = (s: any, now: number) =>
  sourceCoverage(s, s.health, now, cadence);
const byStatus = <T,>(rows: T[], status: (row: T) => CoverageStatus) =>
  [...rows].sort(
    (a, b) =>
      COVERAGE_ORDER.indexOf(status(a)) - COVERAGE_ORDER.indexOf(status(b)),
  );

export function CoverageChip({
  status,
  language,
}: {
  status: CoverageStatus;
  language: Language;
}) {
  return (
    <span
      className={`coverage-chip ${status}`}
      title={translate(language, MEANING[status])}
    >
      {translate(language, LABEL[status])}
    </span>
  );
}
export function sourceStatus(source: any, now: number) {
  return coverageOf(source, now).status;
}
/** Sources being read, and how many of them read successfully on schedule. */
export function freshness(sources: any[], now: number) {
  const statuses = sources
    .map((s) => sourceStatus(s, now))
    .filter((s) => COLLECTING.includes(s));
  return {
    read: statuses.length,
    fresh: statuses.filter((s) => s === "observed" || s === "quiet").length,
    worst: byStatus(statuses, (s) => s)[0] ?? null,
  };
}
function duration(seconds: number, language: Language) {
  const [value, unit] =
    seconds < 90
      ? [seconds, "second"]
      : seconds < 5400
        ? [seconds / 60, "minute"]
        : seconds < 172800
          ? [seconds / 3600, "hour"]
          : [seconds / 86400, "day"];
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: unit !== "second" && value < 10 ? 1 : 0,
  }).format(value);
}
function LagText({
  label,
  lag,
  language,
}: {
  label: string;
  lag: Lag;
  language: Language;
}) {
  const tr = (v: string) => translate(language, v);
  return (
    <small>
      {tr(label)}:{" "}
      {lag.p50 === null || lag.p90 === null
        ? tr("no samples yet")
        : `${tr("median")} ${duration(lag.p50, language)} · p90 ${duration(lag.p90, language)} · n ${lag.n}`}
    </small>
  );
}

export function CoverageView({
  sources,
  incidents,
  catalog,
  now,
  language,
}: {
  sources: any[];
  incidents: IncidentView[];
  catalog: GeospatialCatalog | null;
  now: number;
  language: Language;
}) {
  const tr = (v: string) => translate(language, v);
  const rows = byStatus(
    sources.map((source) => ({ source, coverage: coverageOf(source, now) })),
    (r) => r.coverage.status,
  );
  const read = rows.filter(
    (r) => !["not_configured", "access_unresolved"].includes(r.coverage.status),
  );
  const unread = rows.filter((r) => !read.includes(r));
  const published = publicationLag(incidents, now);
  return (
    <div className="context-section coverage">
      <h2>{tr("Coverage")}</h2>
      <dl className="coverage-legend">
        <dt>{tr("No reports")}</dt>
        <dd>
          {tr(
            "A source that covers the place read it on schedule and listed nothing there.",
          )}
        </dd>
        <dt>{tr("Not covered")}</dt>
        <dd>
          {tr(
            "No source being read covers the place or layer, so an empty map there says nothing.",
          )}
        </dd>
      </dl>
      <p className="coverage-counts">
        {COVERAGE_ORDER.map((status) => {
          const n = rows.filter((r) => r.coverage.status === status).length;
          return n ? (
            <span key={status}>
              <CoverageChip status={status} language={language} /> {n}
            </span>
          ) : null;
        })}
      </p>
      <ul className="coverage-list">
        {read.map(({ source, coverage }) => {
          const latency = sourceLatency(
            source.health,
            published.get(source.id),
            now,
          );
          return (
            <li key={source.id}>
              <div>
                <CoverageChip status={coverage.status} language={language} />
                <span className="coverage-name">
                  {source.name || source.id}
                </span>
              </div>
              <small>
                {tr("Last success")}:{" "}
                {source.health?.last_success_at
                  ? formatAge(source.health.last_success_at, language, now)
                  : tr("never")}
                {" · "}
                {tr("expected every")}{" "}
                {duration(coverage.expected_seconds, language)}
              </small>
              {latency.issuer_to_ingest.n || latency.ingest_to_publication.n ? (
                <>
                  <LagText
                    label="Issuer to ingest"
                    lag={latency.issuer_to_ingest}
                    language={language}
                  />
                  <LagText
                    label="Ingest to publication"
                    lag={latency.ingest_to_publication}
                    language={language}
                  />
                </>
              ) : (
                <small>
                  {tr("Latency")}: {tr("no samples yet")}
                </small>
              )}
              {coverage.unresolved && (
                <small className="coverage-unresolved">
                  <CoverageChip
                    status="access_unresolved"
                    language={language}
                  />{" "}
                  {coverage.unresolved}
                </small>
              )}
            </li>
          );
        })}
      </ul>
      {catalog ? (
        <ul className="coverage-list">
          {catalog.sources.flatMap((layer) =>
            (layer.sensors ?? [layer]).map((item) => {
              const status = layerCoverage(item, layer, now);
              const sensor = "label" in item ? item : null;
              return (
                <li key={layer.id + ":" + item.id}>
                  <div>
                    <CoverageChip status={status} language={language} />
                    <span className="coverage-name">
                      {sensor ? sensor.label : tr(LAYER_LABEL[layer.id])}
                    </span>
                  </div>
                  {sensor?.ended_at ? (
                    <small>
                      {tr("Delivery ended")}{" "}
                      {new Date(sensor.ended_at).toLocaleDateString(language, {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      })}{" "}
                      ·{" "}
                      <a
                        href={sensor.notice_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {tr("Issuer notice")}
                        <ArrowUpRight size={11} />
                      </a>
                    </small>
                  ) : (
                    <small>
                      {tr("Checked")}:{" "}
                      {formatAge(layer.checked_at, language, now)}
                      {" · "}
                      {item.total_available}{" "}
                      {tr(
                        layer.id === "gnss"
                          ? "cells worldwide"
                          : "in this view",
                      )}
                    </small>
                  )}
                </li>
              );
            }),
          )}
        </ul>
      ) : (
        <p className="caution">
          {tr(
            "Satellite sensors and mapping areas are checked while their layer is on.",
          )}
        </p>
      )}
      {unread.length > 0 && (
        <details>
          <summary>
            {tr("Not read")} ({unread.length})
          </summary>
          <ul className="coverage-list">
            {unread.map(({ source, coverage }) => (
              <li key={source.id}>
                <div>
                  <CoverageChip status={coverage.status} language={language} />
                  <span className="coverage-name">
                    {source.name || source.id}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Which sources read a country and how each is doing; silence elsewhere is not coverage. */
export function CountryCoverage({
  sources,
  country,
  now,
  language,
}: {
  sources: any[];
  country: string;
  now: number;
  language: Language;
}) {
  const tr = (v: string) => translate(language, v);
  const rows = byStatus(
    sources
      .filter((s) => coversCountry(s, country))
      .map((source) => ({ source, status: sourceStatus(source, now) })),
    (r) => r.status,
  );
  return (
    <>
      {!rows.some((r) => COLLECTING.includes(r.status)) && (
        <p>
          {tr(
            "No source being read covers this country, so no reports here means not covered.",
          )}
        </p>
      )}
      <ul className="coverage-list">
        {rows.map(({ source, status }) => (
          <li key={source.id}>
            <div>
              <CoverageChip status={status} language={language} />
              <span className="coverage-name">{source.name || source.id}</span>
            </div>
            <small>
              {source.countries.includes("*")
                ? tr("worldwide")
                : source.countries.join(", ")}{" "}
              · {tr("Last success")}:{" "}
              {source.health?.last_success_at
                ? formatAge(source.health.last_success_at, language, now)
                : tr("never")}
            </small>
          </li>
        ))}
      </ul>
    </>
  );
}
