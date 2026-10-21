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
    activation_code?: string;
    hazard?: string;
    kind: "thermal_detection" | "mapping_aoi" | "observed_extent";
    uncertainty?: string;
  };
};
export type LayerSourceHealth = {
  id: "firms" | "copernicus";
  status: "ok" | "error";
  checked_at: string;
  cadence_seconds: number;
  features_count: number;
  source_url: string;
  attribution: string;
  license_url: string;
  error?: string;
};
export type GeospatialCatalog = {
  features: GeoFeature[];
  sources: LayerSourceHealth[];
};
