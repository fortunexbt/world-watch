/** Static files of the public demo, written by scripts/public-snapshot.ts and read by the public client build. */
import type { IncidentView } from "./contracts";
import type { GeospatialCatalog, LayerSourceHealth } from "./geospatial";
export const MANIFEST = "manifest.json";
/** Byte ceilings. A snapshot over any of them fails and the last published one stays live. */
export const PUBLIC_FILE_LIMITS = {
  [MANIFEST]: 64 * 1024,
  "incidents.json": 4 * 1024 * 1024,
  "brief.json": 256 * 1024,
  "geospatial.json": 3 * 1024 * 1024,
} as const;
export type PublicFile = Exclude<
  keyof typeof PUBLIC_FILE_LIMITS,
  typeof MANIFEST
>;
/** The client's time-window choices; each has its own precomputed structured brief. */
export const BRIEF_WINDOWS = ["24", "168", "720", "0"] as const;
export type PublicIncidents = {
  incidents: IncidentView[];
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
};
export type PublicManifest = {
  version: 1;
  generated_at: string;
  /** No model reads or writes anything in the public snapshot. */
  analysis: "none";
  files: Record<PublicFile, { bytes: number; sha256: string }>;
  sources: PublicSourceSummary[];
  layers: Omit<LayerSourceHealth, "sensors">[];
};
