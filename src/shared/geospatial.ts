/** Sourced geospatial context, separate from human incident reports and severity. */
export type GeoJSONPoint = { type: "Point"; coordinates: [number, number] };
export type GeoJSONPolygon = {
  type: "Polygon";
  coordinates: [number, number][][];
};
export type GeoJSONMultiPolygon = {
  type: "MultiPolygon";
  coordinates: [number, number][][][];
};
/** Degrees west, south, east, north; west > east crosses the antimeridian. */
export type Bbox = [west: number, south: number, east: number, north: number];
export type ThermalSensorId = "noaa-20-viirs" | "noaa-21-viirs" | "snpp-viirs";
export type GeoFeature = {
  id: string;
  layer: "thermal" | "emergency_mapping";
  geometry: GeoJSONPoint | GeoJSONPolygon | GeoJSONMultiPolygon;
  name: string;
  observed_at: string | null;
  source_url: string;
  attribution: string;
  license_url: string;
  properties: {
    confidence?: string;
    sensor?: string;
    sensor_id?: ThermalSensorId;
    activation_code?: string;
    hazard?: string;
    kind: "thermal_detection" | "mapping_aoi" | "observed_extent";
    uncertainty?: string;
  };
};
export type ThermalSensorHealth = {
  id: ThermalSensorId;
  label: string;
  status: "ok" | "error";
  features_count: number;
  total_available: number;
  source_url: string;
  error?: string;
};
/**
 * features_count is what this response returns; total_available counts features
 * inside the requested bbox before the response cap. truncated is also true when an
 * acquisition budget skipped upstream records, making total_available a lower bound.
 * A thermal source is "ok" while any sensor is; per-sensor health is in sensors.
 */
export type LayerSourceHealth = {
  id: "firms" | "copernicus";
  status: "ok" | "error";
  checked_at: string;
  cadence_seconds: number;
  features_count: number;
  total_available: number;
  truncated: boolean;
  source_url: string;
  attribution: string;
  license_url: string;
  error?: string;
  sensors?: ThermalSensorHealth[];
};
export type GeospatialCatalog = {
  bbox: Bbox;
  features: GeoFeature[];
  sources: LayerSourceHealth[];
};
