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
export const THERMAL_SENSORS: Record<
  ThermalSensorId,
  { satellite: string; label: string }
> = {
  "noaa-20-viirs": { satellite: "N20", label: "NOAA-20 VIIRS 375 m" },
  "noaa-21-viirs": { satellite: "N21", label: "NOAA-21 VIIRS 375 m" },
  "snpp-viirs": { satellite: "N", label: "Suomi NPP VIIRS 375 m" },
};
export const VIIRS_CONFIDENCE = ["low", "nominal", "high"];
/**
 * Thermal tiles hold per-cell detection counts below THERMAL_POINT_ZOOM and
 * every detection from it to THERMAL_MAX_ZOOM; deeper views overzoom those.
 */
export const THERMAL_POINT_ZOOM = 6,
  THERMAL_MAX_ZOOM = 9;
export const NASA_LICENSE =
  "https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy";
export const firmsCredit = (instrument: string) =>
  `NASA FIRMS / LANCE / EOSDIS, ${instrument} thermal anomalies; derived display, no NASA endorsement`;
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
/** One detection as the map's tiles carry it: sensor, acquisition time, position and confidence. */
export function thermalDetection(
  sensor: ThermalSensorId,
  at: number,
  lon: number,
  lat: number,
  confidence: string,
): GeoFeature {
  const { satellite, label } = THERMAL_SENSORS[sensor],
    observed = new Date(at).toISOString().slice(0, 19) + "Z",
    coordinates: [number, number] = [lon, lat];
  return {
    id: `firms:${satellite}:VIIRS:${observed}:${coordinates.join(":")}`,
    layer: "thermal",
    geometry: { type: "Point", coordinates },
    name: "VIIRS thermal anomaly",
    observed_at: observed,
    source_url: "https://firms.modaps.eosdis.nasa.gov/map/",
    attribution: firmsCredit(label),
    license_url: NASA_LICENSE,
    properties: {
      kind: "thermal_detection",
      sensor: label,
      sensor_id: sensor,
      confidence,
      uncertainty:
        "Satellite thermal detection, not a confirmed wildfire or human incident. Pixel scale 375 m; other heat sources, cloud cover and observation delay apply. No crowd, injury, cause or evacuation inference.",
    },
  };
}
export type ThermalSensorHealth = {
  id: ThermalSensorId;
  label: string;
  /** "ended" once the issuer has stopped delivering the sensor's data; it is no longer read. */
  status: "ok" | "error" | "ended";
  features_count: number;
  total_available: number;
  source_url: string;
  error?: string;
  ended_at?: string;
  /** The issuer's announcement of the end of delivery. */
  notice_url?: string;
};
/**
 * features_count is what the map shows inside the requested bbox: the features in
 * this response, or for thermal every detection in the tile set. total_available
 * counts features inside the bbox before any response cap. truncated is also true when an
 * acquisition budget skipped upstream records, making total_available a lower bound.
 * Copernicus counts AOIs it skipped only for a whole-world bbox, because a skipped
 * AOI's geometry was never fetched and cannot be placed inside a smaller view.
 * A thermal source is "ok" while any sensor is; per-sensor health is in sensors.
 */
export type LayerSourceHealth = {
  /** gnss is the private app's daily ADS-B grid, added beside the catalogue, never in it. */
  id: "firms" | "copernicus" | "gnss";
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
  /** Mapping areas; thermal detections reach the map as tiles. */
  features: GeoFeature[];
  sources: LayerSourceHealth[];
  /** Names the thermal tile set this catalogue counted; null when no sensor returned a file. */
  thermal_version: string | null;
};
