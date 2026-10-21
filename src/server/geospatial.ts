import { validEventTime } from "../shared/contracts.js";
import type {
  GeoFeature,
  GeospatialCatalog,
  LayerSourceHealth,
} from "../shared/geospatial.js";
export type {
  GeoFeature,
  GeospatialCatalog,
  LayerSourceHealth,
} from "../shared/geospatial.js";
export const FIRMS_URL =
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv";
export const CEMS_URL =
  "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=5";
const NASA_LICENSE =
  "https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy";
const CEMS_LICENSE =
  "https://mapping.emergency.copernicus.eu/terms-and-conditions/";
const NASA_CREDIT =
  "NASA FIRMS / LANCE / EOSDIS — NOAA-20 VIIRS 375 m thermal anomalies; derived display, no NASA endorsement";
const CEMS_CREDIT =
  "Copernicus Emergency Management Service — On-Demand Mapping; European Union; derived display";
const MAX_BYTES = 2 * 1024 * 1024;
const cache = new WeakMap<
  typeof fetch,
  { expires: number; value: Promise<GeospatialCatalog> }
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
/** RFC4180 quoted cells, including embedded commas/newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  if (text.length > MAX_BYTES) throw Error("source_byte_limit");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
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
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed) throw Error("invalid_csv");
      cell += c;
    }
    if (rows.length > 30000 || row.length > 100 || cell.length > 100000)
      throw Error("csv_record_limit");
  }
  if (quoted) throw Error("invalid_csv");
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function parseFirms(text: string, now = Date.now()): GeoFeature[] {
  const [headers, ...rows] = parseCsv(text);
  const required = [
    "latitude",
    "longitude",
    "acq_date",
    "acq_time",
    "satellite",
    "confidence",
  ];
  if (!headers || required.some((h) => !headers.includes(h)))
    throw Error("invalid_firms_columns");
  const features = new Map<string, GeoFeature>();
  let knownFormat = 0;
  for (const cells of rows) {
    if (cells.length !== headers.length) continue;
    const r = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
    if (
      r.satellite === "N20" &&
      ["low", "nominal", "high"].includes(r.confidence)
    )
      knownFormat++;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(r.acq_date) ||
      !/^\d{1,4}$/.test(r.acq_time) ||
      r.satellite !== "N20"
    )
      continue;
    const hhmm = r.acq_time.padStart(4, "0");
    if (+hhmm.slice(0, 2) > 23 || +hhmm.slice(2) > 59) continue;
    const at = `${r.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`,
      ms = Date.parse(at);
    if (
      !Number.isFinite(ms) ||
      new Date(ms).toISOString().slice(0, 10) !== r.acq_date ||
      ms > now ||
      ms < now - 86400000
    )
      continue;
    if (!r.longitude.trim() || !r.latitude.trim()) continue;
    const geometry = {
      type: "Point" as const,
      coordinates: [+r.longitude, +r.latitude] as [number, number],
    };
    if (
      !validGeometry(geometry) ||
      !["low", "nominal", "high"].includes(r.confidence)
    )
      continue;
    const id = `firms:N20:VIIRS:${at}:${geometry.coordinates.join(":")}`;
    features.set(id, {
      id,
      layer: "thermal",
      geometry,
      name: "VIIRS thermal anomaly",
      observed_at: at,
      source_url: "https://firms.modaps.eosdis.nasa.gov/map/",
      attribution: NASA_CREDIT,
      license_url: NASA_LICENSE,
      properties: {
        kind: "thermal_detection",
        sensor: "NOAA-20 VIIRS 375 m",
        confidence: r.confidence,
        uncertainty:
          "Satellite thermal detection, not a confirmed wildfire or human incident. Pixel scale 375 m; other heat sources, cloud cover and observation delay apply. No crowd, injury, cause or evacuation inference.",
      },
    });
  }
  if (rows.length && !knownFormat) throw Error("invalid_firms_values");
  return [...features.values()]
    .sort((a, b) => b.observed_at!.localeCompare(a.observed_at!))
    .slice(0, 2000);
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
    for (const area of a.aois.slice(0, 100)) {
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
async function readSource(url: string, fetcher: typeof fetch) {
  const res = await fetcher(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    headers: url.startsWith("https://rapidmapping.emergency.copernicus.eu/")
      ? {
          Accept: "application/json",
          "User-Agent":
            "EuropeWatch/1.0 (public Copernicus contextual data; attribution retained)",
        }
      : { Accept: "text/csv" },
  });
  if (!res.ok || res.status >= 300) {
    await res.body?.cancel();
    throw Error(`source_http_${res.status}`);
  }
  if (Number(res.headers.get("content-length")) > MAX_BYTES) {
    await res.body?.cancel();
    throw Error("source_byte_limit");
  }
  const reader = res.body?.getReader();
  if (!reader) throw Error("source_empty_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw Error("source_byte_limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function load(fetcher: typeof fetch): Promise<GeospatialCatalog> {
  const now = Date.now(),
    checked_at = new Date(now).toISOString();
  const sources: LayerSourceHealth[] = [],
    features: GeoFeature[] = [];
  await Promise.all([
    (async () => {
      let count = 0,
        error: string | undefined;
      try {
        const rows = parseFirms(await readSource(FIRMS_URL, fetcher), now);
        count = rows.length;
        features.push(...rows);
      } catch (e) {
        error =
          e instanceof Error && /^(source_|invalid_|csv_)/.test(e.message)
            ? e.message
            : "source_unavailable";
      }
      sources.push({
        id: "firms",
        status: error ? "error" : "ok",
        checked_at,
        cadence_seconds: 600,
        features_count: count,
        source_url: FIRMS_URL,
        attribution: NASA_CREDIT,
        license_url: NASA_LICENSE,
        ...(error ? { error } : {}),
      });
    })(),
    (async () => {
      let count = 0,
        error: string | undefined;
      try {
        const list = JSON.parse(await readSource(CEMS_URL, fetcher));
        if (!Array.isArray(list?.results)) throw Error("invalid_cems_response");
        let details = 0;
        for (const a of list.results.slice(0, 5)) {
          const date =
            typeof a.eventTime === "string"
              ? Date.parse(
                  a.eventTime +
                    (/Z$|[+-]\d\d:\d\d$/.test(a.eventTime) ? "" : "Z"),
                )
              : NaN;
          if (
            !/^EMSR\d+$/.test(a.code) ||
            !Number.isFinite(date) ||
            date > now ||
            date < now - 30 * 86400000 ||
            a.sensitive === true
          )
            continue;
          if (details++ === 2) break;
          const rows = parseCemsDetail(
            JSON.parse(
              await readSource(
                `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=${a.code}`,
                fetcher,
              ),
            ),
            now,
          );
          count += rows.length;
          features.push(...rows);
        }
      } catch (e) {
        error =
          e instanceof Error && /^(source_|invalid_)/.test(e.message)
            ? e.message
            : "source_unavailable";
      }
      sources.push({
        id: "copernicus",
        status: error ? "error" : "ok",
        checked_at,
        cadence_seconds: 600,
        features_count: count,
        source_url: CEMS_URL,
        attribution: CEMS_CREDIT,
        license_url: CEMS_LICENSE,
        ...(error ? { error } : {}),
      });
    })(),
  ]);
  const unique = [...new Map(features.map((f) => [f.id, f])).values()]
    .sort((a, b) => a.layer.localeCompare(b.layer))
    .slice(0, 2000);
  for (const s of sources)
    s.features_count = unique.filter((f) =>
      s.id === "firms"
        ? f.layer === "thermal"
        : f.layer === "emergency_mapping",
    ).length;
  return {
    features: unique,
    sources: sources.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export function getGeospatialCatalog(
  fetcher: typeof fetch = fetch,
): Promise<GeospatialCatalog> {
  const hit = cache.get(fetcher),
    now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  const value = load(fetcher);
  cache.set(fetcher, { expires: now + 600000, value });
  return value;
}
