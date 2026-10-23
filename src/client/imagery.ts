/**
 * Satellite imagery context, read straight from two keyless public services:
 * NASA GIBS daily mosaics for the map and the Copernicus Data Space STAC
 * catalogue for Sentinel scenes over one incident. Both answer with
 * `access-control-allow-origin: *` (checked 23 October 2026), so the browser
 * asks them directly and nothing is requested until the analyst asks.
 */
export const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
export const STAC = "https://stac.dataspace.copernicus.eu/v1";
export const COPERNICUS_BROWSER = "https://browser.dataspace.copernicus.eu/";

export type GibsLayerId =
  "viirs-true-colour" | "modis-true-colour" | "night-lights";
/** Tile matrix sets, zoom limits and first days are from the GIBS EPSG:3857 capabilities of 23 October 2026. */
export const GIBS_LAYERS: Record<
  GibsLayerId,
  {
    layer: string;
    matrix: string;
    maxzoom: number;
    format: "jpg" | "png";
    first: string;
    label: string;
    sensor: string;
    pass: string;
    resolution: string;
  }
> = {
  "viirs-true-colour": {
    layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    matrix: "GoogleMapsCompatible_Level9",
    maxzoom: 9,
    format: "jpg",
    first: "2018-01-05",
    label: "True colour, VIIRS",
    sensor: "NOAA-20 VIIRS, bands I1, M4, M3",
    pass: "Daytime passes, about 13:30 local solar time",
    resolution: "250 m imagery from 375 m and 750 m bands",
  },
  "modis-true-colour": {
    layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
    matrix: "GoogleMapsCompatible_Level9",
    maxzoom: 9,
    format: "jpg",
    first: "2000-02-24",
    label: "True colour, MODIS",
    sensor: "Terra MODIS, bands 1, 4, 3",
    pass: "Daytime passes, about 10:30 local solar time",
    resolution: "250 m imagery from 250 m and 500 m bands",
  },
  "night-lights": {
    layer: "VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance",
    matrix: "GoogleMapsCompatible_Level8",
    maxzoom: 8,
    format: "png",
    first: "2024-03-25",
    label: "Night lights, VIIRS",
    sensor: "NOAA-20 VIIRS Day/Night Band, at-sensor radiance",
    pass: "Night passes, about 01:30 local solar time",
    resolution: "500 m imagery from a 750 m band",
  },
};
export const GIBS_CREDIT =
  "Imagery from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS); no NASA endorsement";
export const GIBS_TERMS =
  "https://nasa-gibs.github.io/gibs-api-docs/#data-use-guidance-and-acknowledgements";

const DAY = 86400000;
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) =>
  utcDay(Date.parse(day + "T00:00:00Z") + n * DAY);

export function gibsTiles(id: GibsLayerId, day: string) {
  const l = GIBS_LAYERS[id];
  return `${GIBS}/${l.layer}/default/${day}/${l.matrix}/{z}/{y}/{x}.${l.format}`;
}
/** The WMTS DescribeDomains resource: the days a layer has from `from` onwards. */
export function gibsDomainUrl(id: GibsLayerId, from: string) {
  const l = GIBS_LAYERS[id];
  return `${GIBS}/1.0.0/${l.layer}/default/${l.matrix}/all/${from}.xml`;
}
/** Daily intervals from a DescribeDomains reply, such as `2018-02-10/2018-02-21/P1D,2018-02-24/2018-03-12/P1D`. */
export function parseDomain(xml: string): [string, string][] {
  const domain = /<Domain>([^<]*)<\/Domain>/.exec(xml);
  if (!domain) throw Error("invalid_gibs_domain");
  if (!domain[1].trim()) return [];
  return domain[1].split(",").map((part) => {
    const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/P1D$/.exec(
      part.trim(),
    );
    if (!m) throw Error("invalid_gibs_domain");
    return [m[1], m[2]];
  });
}
export const hasDay = (intervals: [string, string][], day: string) =>
  intervals.some(([start, end]) => start <= day && day <= end);
/**
 * The newest day GIBS lists, unless that is today: a daily mosaic fills in pass
 * by pass, so the default is the newest day that has finished.
 */
export function defaultDay(intervals: [string, string][], today: string) {
  const latest = intervals.at(-1)?.[1];
  if (!latest) return null;
  const yesterday = addDays(today, -1);
  return latest >= today && hasDay(intervals, yesterday) ? yesterday : latest;
}
/** Save-Data or prefers-reduced-data, where the browser exposes either. */
export function reducedData() {
  return (
    (navigator as any).connection?.saveData === true ||
    matchMedia("(prefers-reduced-data: reduce)").matches
  );
}

export type SceneCollection = "sentinel-2-l2a" | "sentinel-1-grd";
export const SCENE_COLLECTIONS: SceneCollection[] = [
  "sentinel-2-l2a",
  "sentinel-1-grd",
];
export type Scene = {
  id: string;
  collection: SceneCollection;
  platform: string;
  acquired: string;
  published: string | null;
  cloud_cover: number | null;
  orbit: string | null;
  mode: string | null;
  polarisations: string[];
};
const WINDOW_DAYS = 10,
  SCENE_LIMIT = 10;
/** Ten days either side of the event, never past now. */
export function sceneWindow(eventMs: number, now: number): [string, string] {
  return [
    new Date(eventMs - WINDOW_DAYS * DAY).toISOString(),
    new Date(Math.min(now, eventMs + WINDOW_DAYS * DAY)).toISOString(),
  ];
}
/** Newest scenes whose footprint covers a box about a kilometre wide around the mapped point. */
export function sceneSearchUrl(
  collection: SceneCollection,
  { lon, lat }: { lon: number; lat: number },
  [from, to]: [string, string],
) {
  const d = 0.005,
    round = (n: number) => +n.toFixed(5);
  const box = [
    Math.max(-180, lon - d),
    Math.max(-90, lat - d),
    Math.min(180, lon + d),
    Math.min(90, lat + d),
  ].map(round);
  const url = new URL(STAC + "/search");
  url.search = new URLSearchParams({
    collections: collection,
    bbox: box.join(","),
    datetime: `${from}/${to}`,
    limit: String(SCENE_LIMIT),
    sortby: "-datetime",
    // The full items run to about 70 kB each; these fields are all the panel shows.
    fields: [
      "id",
      "collection",
      "properties.datetime",
      "properties.platform",
      "properties.published",
      "properties.eo:cloud_cover",
      "properties.sat:orbit_state",
      "properties.sar:instrument_mode",
      "properties.sar:polarizations",
      "-geometry",
      "-assets",
      "-links",
      "-bbox",
    ].join(","),
  }).toString();
  return url.toString();
}
const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
export function parseScenes(
  payload: unknown,
  collection: SceneCollection,
): Scene[] {
  const data = payload as any;
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features))
    throw Error("invalid_stac_response");
  return data.features.flatMap((f: any): Scene[] => {
    const p = f?.properties;
    if (
      f?.collection !== collection ||
      typeof f.id !== "string" ||
      !instant(p?.datetime) ||
      typeof p.platform !== "string"
    )
      return [];
    const cloud = p["eo:cloud_cover"],
      polarisations = Array.isArray(p["sar:polarizations"])
        ? p["sar:polarizations"].filter((v: unknown) => typeof v === "string")
        : [];
    // A radar scene opens in the browser by its mode and polarisations, so it needs both.
    if (
      collection === "sentinel-1-grd" &&
      (typeof p["sar:instrument_mode"] !== "string" || !polarisations.length)
    )
      return [];
    return [
      {
        id: f.id,
        collection,
        platform: p.platform,
        acquired: p.datetime,
        published: instant(p.published) ? p.published : null,
        cloud_cover:
          typeof cloud === "number" && cloud >= 0 && cloud <= 100
            ? cloud
            : null,
        orbit:
          typeof p["sat:orbit_state"] === "string"
            ? p["sat:orbit_state"]
            : null,
        mode:
          typeof p["sar:instrument_mode"] === "string"
            ? p["sar:instrument_mode"]
            : null,
        polarisations,
      },
    ];
  });
}
/** Copernicus Browser on the scene's UTC day at the incident, true colour for Sentinel-2 and the scene's radar mode for Sentinel-1. */
export function browserUrl(
  scene: Scene,
  { lon, lat }: { lon: number; lat: number },
) {
  const day = scene.acquired.slice(0, 10);
  const url = new URL(COPERNICUS_BROWSER);
  url.search = new URLSearchParams({
    zoom: "12",
    lat: lat.toFixed(4),
    lng: lon.toFixed(4),
    themeId: "DEFAULT-THEME",
    ...(scene.collection === "sentinel-2-l2a"
      ? { datasetId: "S2_L2A_CDAS", layerId: "1_TRUE_COLOR" }
      : { datasetId: `S1_CDAS_${scene.mode}_${scene.polarisations.join("")}` }),
    fromTime: `${day}T00:00:00.000Z`,
    toTime: `${day}T23:59:59.999Z`,
  }).toString();
  return url.toString();
}
export const SENTINEL_TERMS =
  "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice";
