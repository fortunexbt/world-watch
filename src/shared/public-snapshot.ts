/** Static files of the public demo, written by scripts/public-snapshot.ts and read by the public client build. */
import type { IncidentView } from "./contracts";
import type { CoverageStatus, Lag } from "./coverage";
import type {
  GeospatialCatalog,
  LayerSourceHealth,
  ThermalSensorId,
} from "./geospatial";
export const MANIFEST = "manifest.json",
  THERMAL_ARCHIVE = "thermal.pmtiles";
/** The scheduled workflow rebuilds the snapshot every ten minutes, so no source is read more often. */
export const SNAPSHOT_CADENCE_SECONDS = 600;
/** Byte ceilings. A snapshot over any of them fails and the last published one stays live. */
export const PUBLIC_FILE_LIMITS = {
  [MANIFEST]: 64 * 1024,
  "incidents.json": 4 * 1024 * 1024,
  "brief.json": 256 * 1024,
  "geospatial.json": 3 * 1024 * 1024,
  // Every thermal detection: 4.6 MB for 218,308 real ones, about 21 bytes each, and the
  // FIRMS byte caps admit about 860,000.
  [THERMAL_ARCHIVE]: 24 * 1024 * 1024,
} as const;
/** Byte ceiling of each feed file and of the feed index. */
export const FEED_FILE_LIMIT = 512 * 1024;
export type PublicFile = Exclude<
  keyof typeof PUBLIC_FILE_LIMITS,
  typeof MANIFEST
>;
/** The client's time-window choices; each has its own precomputed structured brief. */
export const BRIEF_WINDOWS = ["24", "168", "720", "0"] as const;
export type PublicIncidents = {
  incidents: IncidentView[];
  /** Per feed record, the incident ID its feed entry is keyed to, a digest of its alert-material-v1 projection and when that last changed. */
  feed_state: Record<string, { entry: string; material: string; updated: string }>;
  sources: any[];
  limited: boolean;
};
export type PublicBriefs = Record<(typeof BRIEF_WINDOWS)[number], unknown>;
export type PublicGeospatial = GeospatialCatalog;
export type PublicSourceSummary = {
  id: string;
  name: string;
  url: string;
  status: "ok" | "not_modified" | "skipped" | "error";
  received: number;
  error?: string;
  /** This run's time when the read succeeded, otherwise carried from the previous manifest. */
  last_success_at: string | null;
  /** Records kept from the previous snapshot because this run's read failed. */
  carried_forward: number;
  attribution: string;
  /** Shown in the demo, but excluded from any export or download it offers. */
  redistribute: boolean;
  /** As of generated_at; a reader later than that should judge freshness again from last_success_at. */
  coverage: CoverageStatus;
  latency: { issuer_to_ingest: Lag; ingest_to_publication: Lag };
};
export type PublicManifest = {
  version: 1;
  generated_at: string;
  /** No model reads or writes anything in the public snapshot. */
  analysis: "none";
  files: Record<PublicFile, { bytes: number; sha256: string }>;
  sources: PublicSourceSummary[];
  layers: (Omit<LayerSourceHealth, "sensors"> & {
    coverage: CoverageStatus;
    sensors?: { id: ThermalSensorId; coverage: CoverageStatus }[];
  })[];
  /** The Atom and GeoJSON feeds beside the snapshot, listed in `index`. */
  feeds: { index: string; files: number; bytes: number };
};
