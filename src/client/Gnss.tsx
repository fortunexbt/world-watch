import { useEffect, useRef } from "react";
import type { LayerSourceHealth } from "../shared/geospatial";
import {
  GNSS_METHOD,
  gnssLevel,
  gnssShare,
  validGnss,
  type GnssGrid,
  type GnssLevel,
  type GnssManifest,
} from "../shared/gnss";
import { translate, type Language } from "./locale";

export type Gnss = { manifest: GnssManifest; grid: GnssGrid };
/** Muted where aircraft report normally, so observed coverage reads apart from blank no-data cells. */
export const GNSS_COLORS: Record<GnssLevel, string> = {
  low: "#5E9C8A",
  medium: "#D9B44A",
  high: "#E0634F",
};
export const GNSS_BANDS: [GnssLevel, string][] = [
  ["low", "under 2%"],
  ["medium", "2 to 10%"],
  ["high", "over 10%"],
];
const BASE = import.meta.env.BASE_URL + "gnss/";

/**
 * The daily grid scripts/gnss-grid.ts writes into the private build's gnss/
 * folder. The Worker serves it to the owner only; the public demo never has it.
 */
export async function loadGnss(signal: AbortSignal): Promise<Gnss> {
  const read = async (name: string) => {
    const r = await fetch(BASE + name, { credentials: "same-origin", signal });
    // A missing file falls through to the app shell, so only JSON counts.
    if (!r.ok || !r.headers.get("content-type")?.includes("json"))
      throw Error("No GNSS interference grid has been built for this app.");
    return r.json();
  };
  const manifest = await read("manifest.json");
  const file = manifest?.grid?.file;
  if (typeof file !== "string" || !/^gnss-\d{4}-\d{2}-\d{2}\.json$/.test(file))
    throw Error("The GNSS interference grid failed validation.");
  const grid = await read(file);
  if (!validGnss(manifest, grid))
    throw Error("The GNSS interference grid failed validation.");
  return { manifest, grid };
}

/** The grid as a context layer, judged against its daily cadence by the coverage view. */
export function gnssHealth({ manifest, grid }: Gnss): LayerSourceHealth {
  return {
    id: "gnss",
    status: "ok",
    checked_at: manifest.generated_at,
    cadence_seconds: 86400,
    features_count: grid.cells.length,
    total_available: grid.cells.length,
    truncated: false,
    source_url: manifest.source.url,
    attribution: manifest.attribution,
    license_url: manifest.license_url,
  };
}

export function GnssLegend({ language }: { language: Language }) {
  const tr = (text: string) => translate(language, text);
  return (
    <div className="legend-row">
      <span
        title={tr(
          "Share of aircraft reporting degraded GNSS accuracy and integrity in each half-degree cell over one UTC day. Blank cells had too few aircraft.",
        )}
      >
        {tr("GNSS degraded")}
      </span>
      {GNSS_BANDS.map(([level, label]) => (
        <span key={level}>
          <i
            className="gnss-swatch"
            style={{ background: GNSS_COLORS[level] }}
          />
          {tr(label)}
        </span>
      ))}
    </div>
  );
}

export function GnssPanel({
  gnss,
  cell,
  error,
  loading,
  language,
}: {
  gnss: Gnss | null;
  cell: number | null;
  error: string;
  loading: boolean;
  language: Language;
}) {
  const tr = (text: string) => translate(language, text);
  const number = (value: number) =>
    value.toLocaleString(language === "it" ? "it-IT" : "en-GB");
  const fill = (text: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce(
      (out, [key, value]) =>
        out.replace(
          `{${key}}`,
          typeof value === "number" ? number(value) : value,
        ),
      tr(text),
    );
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = cell === null ? undefined : gnss?.grid.cells[cell];
  useEffect(() => {
    heading.current?.focus();
  }, [cell]);
  const { healthy, degraded } = GNSS_METHOD;
  return (
    <section className="panel-content geospatial-panel">
      <p className="eyebrow">{tr("Context layer")}</p>
      <h1 ref={heading} tabIndex={-1}>
        {tr("GNSS interference from aircraft reports")}
      </h1>
      <p className="caution">
        {tr(
          "Share of aircraft reporting degraded GNSS accuracy and integrity. It can indicate jamming or spoofing, and is also caused by faulty equipment, manoeuvres that block the antenna and gaps in receiver coverage. It does not prove interference.",
        )}
      </p>
      {loading && <p role="status">{tr("Loading the GNSS grid…")}</p>}
      {error && (
        <p className="error" role="status">
          {tr(error)}
        </p>
      )}
      {gnss && (
        <>
          {selected && (
            <dl className="times">
              <dt>{tr("Cell")}</dt>
              <dd>
                {fill(
                  "{south}° to {north}° latitude, {west}° to {east}° longitude",
                  {
                    south: selected[0],
                    north: selected[0] + gnss.grid.cell_degrees,
                    west: selected[1],
                    east: selected[1] + gnss.grid.cell_degrees,
                  },
                )}
              </dd>
              <dt>{tr("Aircraft")}</dt>
              <dd>{number(selected[2])}</dd>
              <dt>{tr("Reported degraded GNSS")}</dt>
              <dd>
                {number(selected[3])} ·{" "}
                {fill("{share}% after discounting one aircraft", {
                  share:
                    Math.round(gnssShare(selected[2], selected[3]) * 1000) / 10,
                })}{" "}
                ·{" "}
                {tr(
                  GNSS_BANDS.find(
                    ([l]) => l === gnssLevel(selected[2], selected[3]),
                  )![1],
                )}
              </dd>
            </dl>
          )}
          <p>
            {fill(
              "UTC day {date}: {cells} half-degree cells with at least {min} aircraft, from {aircraft} aircraft and {reports} classified reports.",
              {
                date: gnss.manifest.date,
                cells: gnss.grid.cells.length,
                min: GNSS_METHOD.min_aircraft,
                aircraft: gnss.manifest.counts.reference_aircraft,
                reports: gnss.manifest.counts.classified_reports,
              },
            )}
          </p>
          <p>
            {tr(
              "Blank cells had fewer aircraft, or none in range of a receiver, so they mean no data rather than no interference.",
            )}
          </p>
          <h2>{tr("Method")}</h2>
          <p>
            {fill(
              "Each aircraft counts once per cell, and only if at some point that day it reported the accuracy the FAA requires of ADS-B Out (NACp {nacp}, NIC {nic}, SIL {sil}), so avionics that never report it are left out. It counts as degraded in a cell where it reported NACp {low} or less with NIC {lowNic} or less, a position uncertain by 4 nautical miles or more, or unknown. Shading follows GPSJam's published bands after subtracting one degraded aircraft per cell.",
              {
                nacp: healthy.nac_p_min,
                nic: healthy.nic_min,
                sil: healthy.sil,
                low: degraded.nac_p_max,
                lowNic: degraded.nic_max,
              },
            )}
          </p>
          <p className="rights">
            {/* The ODbL 4.3 notice keeps its database name, which English copy would otherwise respace. */}
            {language === "it"
              ? tr(gnss.manifest.attribution)
              : gnss.manifest.attribution}{" "}
            <a href={gnss.manifest.source.url} target="_blank" rel="noreferrer">
              {gnss.manifest.source.release}
            </a>{" "}
            ·{" "}
            <a
              href={gnss.manifest.license_url}
              target="_blank"
              rel="noreferrer"
            >
              ODbL 1.0
            </a>{" "}
            ·{" "}
            <a href={BASE + gnss.manifest.grid.file} download>
              {tr("Download this grid (ODbL)")}
            </a>{" "}
            ·{" "}
            <a href={BASE + "manifest.json"} download>
              {tr("Method and counts")}
            </a>
          </p>
        </>
      )}
    </section>
  );
}
