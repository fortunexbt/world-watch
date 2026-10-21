/** Public provider-declared camera context; never incident or crowd-analysis evidence by itself. */
export type PublicCamera = {
  id: string;
  provider: "digitraffic" | "vegvesen";
  name: string;
  country: "FI" | "NO";
  lon: number;
  lat: number;
  kind: "snapshot" | "video";
  image_url: string;
  video_url?: string;
  has_audio?: boolean | null;
  video_error?: string;
  source_url: string;
  license_url: string;
  attribution: string;
  /** Capture/measurement timestamp only. Catalog publication or metadata time is never substituted. */
  updated_at: string | null;
  /** Provider-supplied capture cadence, otherwise unknown. */
  cadence_seconds: number | null;
};
export type CameraSourceHealth = {
  id: PublicCamera["provider"];
  status: "ok" | "error";
  attribution: string;
  license_url: string;
  checked_at: string;
  /** Our bounded catalog refresh cadence, not a promise of image capture frequency. */
  cadence_seconds: number;
  error?: string;
  catalog_count?: number;
  cameras_count?: number;
};
export type PublicCameraCatalog = {
  cameras: PublicCamera[];
  sources: CameraSourceHealth[];
};
