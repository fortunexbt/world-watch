import { validEventTime } from "../shared/contracts.js";
import {
  firmsCredit,
  NASA_LICENSE,
  THERMAL_SENSORS,
  VIIRS_CONFIDENCE,
  type Bbox,
  type GeoFeature,
  type GeospatialCatalog,
  type LayerSourceHealth,
  type ThermalSensorId,
} from "../shared/geospatial.js";
import {
  encodeThermalTile,
  indexDetections,
  type Detections,
  type ThermalIndex,
} from "./thermal-tiles.js";
export type {
  Bbox,
  GeoFeature,
  GeospatialCatalog,
  LayerSourceHealth,
} from "../shared/geospatial.js";
const FIRMS_DATA = "https://firms.modaps.eosdis.nasa.gov/data/active_fire";
/** Public global 24 h files, one per satellite, so worldwide coverage needs no MAP_KEY. */
export const FIRMS_SENSORS: readonly {
  id: ThermalSensorId;
  satellite: string;
  label: string;
  url: string;
  /** When the issuer stops delivering new data; the file is not read from then on. */
  ended?: { at: string; notice_url: string };
}[] = [
  {
    id: "noaa-20-viirs",
    ...THERMAL_SENSORS["noaa-20-viirs"],
    url: `${FIRMS_DATA}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv`,
  },
  {
    id: "noaa-21-viirs",
    ...THERMAL_SENSORS["noaa-21-viirs"],
    url: `${FIRMS_DATA}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv`,
  },
  {
    id: "snpp-viirs",
    ...THERMAL_SENSORS["snpp-viirs"],
    url: `${FIRMS_DATA}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv`,
    // FIRMS banner, read 23 October 2026: "Delivery of new Suomi NPP data ceases on Nov. 2, 2026." The linked
    // NASA Earthdata notice gives 13:00 UTC and says the date may change.
    ended: {
      at: "2026-11-02T13:00:00Z",
      notice_url:
        "https://www.earthdata.nasa.gov/data/alerts-outages/reminder-new-suomi-npp-observations-cease-november-2-2026",
    },
  },
];
type ThermalSensor = (typeof FIRMS_SENSORS)[number];
const CEMS_API =
  "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api";
const CEMS_LIST_LIMIT = 25,
  CEMS_DETAILS = 10,
  CEMS_AOIS = 100;
export const CEMS_URL = `${CEMS_API}/public-activations-info/?limit=${CEMS_LIST_LIMIT}`;
export const WORLD: Bbox = [-180, -90, 180, 90];
const USER_AGENT =
  "WorldWatch/1.0 (+https://github.com/fortunexbt/world-watch; public contextual data; attribution retained)";
const CEMS_LICENSE =
  "https://mapping.emergency.copernicus.eu/terms-and-conditions/";
const CEMS_CREDIT =
  "Copernicus Emergency Management Service, On-Demand Mapping; © European Union; derived display";
// Measured 2026-10-21: each global VIIRS 24 h file was 8.3 to 9.8 MB.
const FIRMS_BYTES = 24 * 1024 * 1024,
  JSON_BYTES = 2 * 1024 * 1024;
type Loaded = {
  checked_at: string;
  thermal: {
    sensor: ThermalSensor;
    data?: Detections;
    error?: string;
    ended?: boolean;
  }[];
  cems: {
    features: GeoFeature[];
    truncated: boolean;
    skipped_aois: number;
    error?: string;
  };
};
const cache = new WeakMap<
  typeof fetch,
  { expires: number; value: Promise<Loaded> }
>();
/** Each refresh's tile index and the tiles encoded from it so far. */
const tileSets = new WeakMap<
  Loaded,
  {
    version: string;
    index: ThermalIndex;
    tiles: Map<string, Uint8Array<ArrayBuffer>>;
  }
>();
const coordinate = (c: unknown): c is [number, number] =>
  Array.isArray(c) &&
  c.length === 2 &&
  Number.isFinite(c[0]) &&
  Number.isFinite(c[1]) &&
  Math.abs(c[0]) <= 180 &&
  Math.abs(c[1]) <= 90;
export function validGeometry(value: unknown): value is GeoFeature["geometry"] {
  const g = value as any;
  if (!g || typeof g !== "object") return false;
  if (g.type === "Point") return coordinate(g.coordinates);
  const polygons =
    g.type === "Polygon"
      ? [g.coordinates]
      : g.type === "MultiPolygon"
        ? g.coordinates
        : null;
  if (!Array.isArray(polygons) || !polygons.length) return false;
  let count = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    for (const ring of polygon) {
      if (
        !Array.isArray(ring) ||
        ring.length < 4 ||
        (count += ring.length) > 5000 ||
        !ring.every(coordinate)
      )
        return false;
      if (
        ring[0][0] !== ring[ring.length - 1][0] ||
        ring[0][1] !== ring[ring.length - 1][1]
      )
        return false;
      let area = 0;
      for (let i = 1; i < ring.length; i++)
        area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
      if (!Number.isFinite(area) || Math.abs(area) < 1e-12) return false;
    }
  }
  return true;
}
/** WKT polygon grammar only; no guessed centroid or arbitrary coordinate transformations. */
export function parseWktGeometry(text: unknown): GeoFeature["geometry"] | null {
  if (typeof text !== "string" || text.length > 500000) return null;
  const match = text.match(/^\s*(POLYGON|MULTIPOLYGON)\s*(\(.*\))\s*$/s);
  if (!match) return null;
  const tokens =
    match[2].match(/[()]|,|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|\S+/g) ??
    [];
  let pos = 0;
  const list = (depth: number): any[] => {
    if (depth > 4 || tokens[pos++] !== "(") throw Error();
    const out: any[] = [];
    while (true) {
      if (tokens[pos] === "(") out.push(list(depth + 1));
      else {
        const x = tokens[pos++],
          y = tokens[pos++];
        if (!x || !y || !/^[-+\d.]/.test(x) || !/^[-+\d.]/.test(y))
          throw Error();
        out.push([Number(x), Number(y)]);
      }
      const sep = tokens[pos++];
      if (sep === ")") return out;
      if (sep !== "," || out.length > 5000) throw Error();
    }
  };
  try {
    const coordinates = list(0);
    const g = {
      type: match[1] === "POLYGON" ? "Polygon" : "MultiPolygon",
      coordinates,
    };
    return pos === tokens.length && validGeometry(g) ? g : null;
  } catch {
    return null;
  }
}
/** RFC4180 quoted cells, including embedded commas/newlines and doubled quotes, fed in chunks of any size. */
export function csvParser(onRow: (cells: string[]) => void) {
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false,
    pending = "";
  // Only called with text ending in a line feed (or at the end), so lookahead stays in the chunk.
  const scan = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            quoted = false;
            closed = true;
          }
        } else cell += c;
      } else if (c === '"') {
        if (cell || closed) throw Error("invalid_csv");
        quoted = true;
      } else if (c === "," || c === "\n" || c === "\r") {
        row.push(cell);
        cell = "";
        closed = false;
        if (c !== ",") {
          if (row.some(Boolean)) onRow(row);
          row = [];
          if (c === "\r" && text[i + 1] === "\n") i++;
        }
      } else {
        if (closed) throw Error("invalid_csv");
        cell += c;
      }
      if (row.length > 100 || cell.length > 100000)
        throw Error("csv_record_limit");
    }
  };
  return {
    push(chunk: string) {
      const text = pending + chunk,
        cut = text.lastIndexOf("\n") + 1;
      pending = text.slice(cut);
      if (pending.length > 1024 * 1024) throw Error("csv_record_limit");
      scan(text.slice(0, cut));
    },
    end() {
      scan(pending);
      pending = "";
      if (quoted) throw Error("invalid_csv");
      row.push(cell);
      if (row.some(Boolean)) onRow(row);
      row = [];
      cell = "";
    },
  };
}
/** One sensor's global file: UTC acquisitions within 24 h, newest first, duplicate rows dropped. */
export function firmsParser(sensor: ThermalSensor, now = Date.now()) {
  const required = [
    "latitude",
    "longitude",
    "acq_date",
    "acq_time",
    "satellite",
    "confidence",
  ] as const;
  type Columns = Record<(typeof required)[number], number>;
  let col: Columns | undefined,
    width = 0,
    rows = 0,
    knownFormat = 0;
  const lon: number[] = [],
    lat: number[] = [],
    at: number[] = [],
    confidence: number[] = [];
  const csv = csvParser((cells) => {
    if (!col) {
      if (required.some((h) => !cells.includes(h)))
        throw Error("invalid_firms_columns");
      col = Object.fromEntries(
        required.map((h) => [h, cells.indexOf(h)]),
      ) as Columns;
      width = cells.length;
      return;
    }
    rows++;
    if (cells.length !== width || cells[col.satellite] !== sensor.satellite)
      return;
    const level = VIIRS_CONFIDENCE.indexOf(cells[col.confidence]);
    if (level < 0) return;
    knownFormat++;
    const date = cells[col.acq_date],
      time = cells[col.acq_time];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,4}$/.test(time)) return;
    const hhmm = time.padStart(4, "0");
    if (+hhmm.slice(0, 2) > 23 || +hhmm.slice(2) > 59) return;
    const ms = Date.parse(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
    if (
      !Number.isFinite(ms) ||
      new Date(ms).toISOString().slice(0, 10) !== date ||
      ms > now ||
      ms < now - 86400000
    )
      return;
    const x = cells[col.longitude],
      y = cells[col.latitude];
    if (!x.trim() || !y.trim() || !coordinate([+x, +y])) return;
    lon.push(+x);
    lat.push(+y);
    at.push(ms);
    confidence.push(level);
  });
  return {
    push: csv.push,
    end(): Detections {
      csv.end();
      if (!col) throw Error("invalid_firms_columns");
      if (rows && !knownFormat) throw Error("invalid_firms_values");
      const order = [...at.keys()].sort(
        (a, b) => at[b] - at[a] || lon[a] - lon[b] || lat[a] - lat[b],
      );
      const keep = order.filter(
        (i, k) =>
          !k ||
          at[i] !== at[order[k - 1]] ||
          lon[i] !== lon[order[k - 1]] ||
          lat[i] !== lat[order[k - 1]],
      );
      return {
        lon: Float64Array.from(keep, (i) => lon[i]),
        lat: Float64Array.from(keep, (i) => lat[i]),
        at: Float64Array.from(keep, (i) => at[i]),
        confidence: Uint8Array.from(keep, (i) => confidence[i]),
      };
    },
  };
}
export function parseCemsDetail(
  payload: unknown,
  now = Date.now(),
): GeoFeature[] {
  const data = payload as any;
  if (!Array.isArray(data?.results)) throw Error("invalid_cems_response");
  const out: GeoFeature[] = [];
  for (const a of data.results.slice(0, 2)) {
    if (
      a.sensitive !== false ||
      !/^EMSR\d+$/.test(a.code) ||
      typeof a.name !== "string" ||
      !Array.isArray(a.aois)
    )
      continue;
    // CEMS documents its otherwise offset-less eventTime field as UTC.
    const at =
      typeof a.eventTime === "string"
        ? a.eventTime + (/Z$|[+-]\d\d:\d\d$/.test(a.eventTime) ? "" : "Z")
        : "";
    const ms = Date.parse(at);
    if (
      !validEventTime(at) ||
      !Number.isFinite(ms) ||
      ms > now ||
      ms < now - 30 * 86400000
    )
      continue;
    for (const area of a.aois.slice(0, CEMS_AOIS)) {
      if (!Number.isSafeInteger(area.number) || typeof area.name !== "string")
        continue;
      const geometry = parseWktGeometry(area.extent);
      if (!geometry) continue;
      out.push({
        id: `cems:${a.code}:aoi:${area.number}`,
        layer: "emergency_mapping",
        geometry,
        name: `${a.name} — ${area.name}`,
        observed_at: new Date(ms).toISOString(),
        source_url: `https://mapping.emergency.copernicus.eu/activations/${a.code}/`,
        attribution: CEMS_CREDIT,
        license_url: CEMS_LICENSE,
        properties: {
          kind: "mapping_aoi",
          activation_code: a.code,
          hazard:
            typeof a.category === "string"
              ? a.category.slice(0, 100)
              : undefined,
          uncertainty:
            "Mapping area of interest: coverage of satellite analysis, not the observed hazard extent, an evacuation zone or displaced population. Timestamp is the reported event start, not imagery capture. Activation closure does not establish that an emergency ended.",
        },
      });
    }
  }
  return out;
}
async function* readSource(
  url: string,
  fetcher: typeof fetch,
  maxBytes: number,
  accept: string,
) {
  const res = await fetcher(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: accept, "User-Agent": USER_AGENT },
  });
  if (!res.ok || res.status >= 300) {
    await res.body?.cancel();
    throw Error(`source_http_${res.status}`);
  }
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel();
    throw Error("source_byte_limit");
  }
  const reader = res.body?.getReader();
  if (!reader) throw Error("source_empty_response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if ((size += r.value.length) > maxBytes) throw Error("source_byte_limit");
      yield decoder.decode(r.value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    await reader.cancel();
  }
}
async function readJson(url: string, fetcher: typeof fetch) {
  let text = "";
  for await (const chunk of readSource(
    url,
    fetcher,
    JSON_BYTES,
    "application/json",
  ))
    text += chunk;
  return JSON.parse(text);
}
const sourceError = (e: unknown) =>
  e instanceof Error && /^(source_|invalid_|csv_)/.test(e.message)
    ? e.message
    : "source_unavailable";
// The list reports n_aois as a string; anything unreadable counts as none so the skip total stays a lower bound.
const listedAois = (a: any) => {
  const n = Number(a.n_aois);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
async function loadCems(
  fetcher: typeof fetch,
  now: number,
): Promise<Loaded["cems"]> {
  try {
    const list = await readJson(CEMS_URL, fetcher);
    if (!Array.isArray(list?.results)) throw Error("invalid_cems_response");
    const listed = list.results.slice(0, CEMS_LIST_LIMIT);
    const recent = listed.filter((a: any) => {
      const date =
        typeof a.eventTime === "string"
          ? Date.parse(
              a.eventTime + (/Z$|[+-]\d\d:\d\d$/.test(a.eventTime) ? "" : "Z"),
            )
          : NaN;
      return (
        /^EMSR\d+$/.test(a.code) &&
        Number.isFinite(date) &&
        date <= now &&
        date >= now - 30 * 86400000 &&
        a.sensitive !== true
      );
    });
    const fetched = recent.slice(0, CEMS_DETAILS);
    const details = await Promise.all(
      fetched.map(async (a: any) =>
        parseCemsDetail(
          await readJson(
            `${CEMS_API}/public-activations/?code=${a.code}`,
            fetcher,
          ),
          now,
        ),
      ),
    );
    return {
      features: details.flat(),
      // Skipped activations, a full list page still inside the window, or AOIs past the per-activation cap.
      truncated:
        recent.length > fetched.length ||
        (listed.length === CEMS_LIST_LIMIT && recent.includes(listed.at(-1))) ||
        fetched.some((a: any) => listedAois(a) > CEMS_AOIS),
      skipped_aois:
        recent
          .slice(CEMS_DETAILS)
          .reduce((n: number, a: any) => n + listedAois(a), 0) +
        fetched.reduce(
          (n: number, a: any) => n + Math.max(0, listedAois(a) - CEMS_AOIS),
          0,
        ),
    };
  } catch (e) {
    return {
      features: [],
      truncated: false,
      skipped_aois: 0,
      error: sourceError(e),
    };
  }
}
async function load(fetcher: typeof fetch, now: number): Promise<Loaded> {
  const [thermal, cems] = await Promise.all([
    Promise.all(
      FIRMS_SENSORS.map(async (sensor) => {
        if (sensor.ended && Date.parse(sensor.ended.at) <= now)
          return { sensor, ended: true };
        try {
          const parser = firmsParser(sensor, now);
          for await (const text of readSource(
            sensor.url,
            fetcher,
            FIRMS_BYTES,
            "text/csv",
          ))
            parser.push(text);
          return { sensor, data: parser.end() };
        } catch (e) {
          return { sensor, error: sourceError(e) };
        }
      }),
    ),
    loadCems(fetcher, now),
  ]);
  return { checked_at: new Date(now).toISOString(), thermal, cems };
}
/** Extent overlap; a point is a zero-size extent. */
function overlaps(
  [west, south, east, north]: Bbox,
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
) {
  return (
    minLat <= north &&
    maxLat >= south &&
    (west <= east
      ? minLon <= east && maxLon >= west
      : maxLon >= west || minLon <= east)
  );
}
function intersects(geometry: GeoFeature["geometry"], bbox: Bbox) {
  const points =
    geometry.type === "Point"
      ? [geometry.coordinates]
      : geometry.type === "Polygon"
        ? geometry.coordinates.flat()
        : geometry.coordinates.flat(2);
  const lons = points.map((p) => p[0]),
    lats = points.map((p) => p[1]);
  return overlaps(
    bbox,
    Math.min(...lons),
    Math.min(...lats),
    Math.max(...lons),
    Math.max(...lats),
  );
}
/** Detections inside the bbox, per sensor. */
const thermalCounts = (thermal: Loaded["thermal"], bbox: Bbox) =>
  thermal.map(({ data }) => {
    let n = 0;
    if (data)
      for (let i = 0; i < data.at.length; i++)
        if (overlaps(bbox, data.lon[i], data.lat[i], data.lon[i], data.lat[i]))
          n++;
    return n;
  });
export function parseBbox(value: string): Bbox | null {
  const parts = value.split(",");
  if (
    parts.length !== 4 ||
    !parts.every((p) => /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(p))
  )
    return null;
  const [west, south, east, north] = parts.map(Number);
  return Math.abs(west) <= 180 &&
    Math.abs(east) <= 180 &&
    west !== east &&
    south >= -90 &&
    north <= 90 &&
    south < north
    ? [west, south, east, north]
    : null;
}
function loaded(fetcher: typeof fetch, now = Date.now()) {
  const hit = cache.get(fetcher);
  if (hit && hit.expires > now) return hit.value;
  const value = load(fetcher, now);
  cache.set(fetcher, { expires: now + 600000, value });
  return value;
}
const tileVersion = (checked_at: string) => Date.parse(checked_at).toString(36);
async function tileSet(fetcher: typeof fetch, now: number) {
  const current = await loaded(fetcher, now);
  let set = tileSets.get(current);
  if (!set) {
    set = {
      version: tileVersion(current.checked_at),
      index: indexDetections(
        current.thermal.flatMap(({ sensor, data }) =>
          data ? [{ sensor: sensor.id, data }] : [],
        ),
      ),
      tiles: new Map(),
    };
    tileSets.set(current, set);
  }
  return set;
}
/** Every detection of the current refresh, indexed for tiling. */
export const getThermalIndex = async (
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) => (await tileSet(fetcher, now)).index;
/** One tile of the current refresh, encoded once; null when it holds no detection. */
export async function getThermalTile(
  z: number,
  x: number,
  y: number,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const { version, index, tiles } = await tileSet(fetcher, now),
    key = `${z}/${x}/${y}`;
  // Only occupied tiles are kept, so the copy never outgrows the tile set.
  const tile = tiles.get(key) ?? encodeThermalTile(index, z, x, y);
  if (tile) tiles.set(key, tile);
  return { version, tile };
}
export async function getGeospatialCatalog(
  bbox: Bbox = WORLD,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<GeospatialCatalog> {
  const { checked_at, thermal, cems } = await loaded(fetcher, now);
  const mapping = cems.features.filter((f) => intersects(f.geometry, bbox)),
    counts = thermalCounts(thermal, bbox);
  const sensors = thermal.map(({ sensor, error, ended }, k) => ({
    id: sensor.id,
    label: sensor.label,
    status: ended
      ? ("ended" as const)
      : error
        ? ("error" as const)
        : ("ok" as const),
    features_count: counts[k],
    total_available: counts[k],
    source_url: sensor.url,
    ...(error ? { error } : {}),
    ...(ended
      ? { ended_at: sensor.ended!.at, notice_url: sensor.ended!.notice_url }
      : {}),
  }));
  const failed = sensors.find((s) => s.error),
    read = thermal.filter((t) => !t.ended).map((t) => t.sensor.label);
  const sources: LayerSourceHealth[] = [
    {
      id: "copernicus",
      status: cems.error ? "error" : "ok",
      checked_at,
      cadence_seconds: 600,
      features_count: mapping.length,
      // Skipped AOIs have no geometry yet, so only a whole-world request can count them as inside its view.
      total_available:
        mapping.length + (bbox.join() === WORLD.join() ? cems.skipped_aois : 0),
      truncated: cems.truncated,
      source_url: CEMS_URL,
      attribution: CEMS_CREDIT,
      license_url: CEMS_LICENSE,
      ...(cems.error ? { error: cems.error } : {}),
    },
    {
      id: "firms",
      status: sensors.some((s) => s.status === "ok") ? "ok" : "error",
      checked_at,
      cadence_seconds: 600,
      features_count: sensors.reduce((n, s) => n + s.features_count, 0),
      total_available: sensors.reduce((n, s) => n + s.total_available, 0),
      truncated: false,
      source_url: "https://firms.modaps.eosdis.nasa.gov/active_fire/",
      attribution: firmsCredit(
        read.length > 1
          ? `${read.slice(0, -1).map((l) => l.replace(/ VIIRS 375 m$/, "")).join(", ")} and ${read.at(-1)}`
          : read.join(""),
      ),
      license_url: NASA_LICENSE,
      ...(failed ? { error: failed.error } : {}),
      sensors,
    },
  ];
  return {
    bbox,
    features: mapping,
    sources,
    thermal_version: thermal.some((t) => t.data)
      ? tileVersion(checked_at)
      : null,
  };
}
