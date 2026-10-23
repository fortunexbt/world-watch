// Mapbox Vector Tiles of every thermal detection, built from an index sorted
// once per FIRMS refresh. Below THERMAL_POINT_ZOOM a tile holds one point per
// occupied cell with its exact count, so counts at every zoom sum to the total;
// from it to THERMAL_MAX_ZOOM a tile holds each detection, grouped into one
// MultiPoint per sensor, acquisition minute and confidence.
import {
  THERMAL_MAX_ZOOM,
  THERMAL_POINT_ZOOM,
  VIIRS_CONFIDENCE,
  type ThermalSensorId,
} from "../shared/geospatial.js";

export type Detections = {
  lon: Float64Array;
  lat: Float64Array;
  at: Float64Array;
  confidence: Uint8Array;
};
export type ThermalIndex = {
  /** Morton code of each detection's THERMAL_MAX_ZOOM tile, ascending. */
  key: Uint32Array;
  /** Web Mercator position in [0, 1). */
  x: Float64Array;
  y: Float64Array;
  sensor: Uint8Array;
  at: Float64Array;
  confidence: Uint8Array;
  sensors: ThermalSensorId[];
};
export const EXTENT = 4096;
/** Cells per tile side below THERMAL_POINT_ZOOM: one cell every 8 screen pixels. */
const CELLS = 64;
const MAX_LAT = 85.0511287798;

const morton = (x: number, y: number) => {
  let key = 0;
  for (let bit = 0; bit < THERMAL_MAX_ZOOM; bit++)
    key |= (((x >> bit) & 1) << (2 * bit)) | (((y >> bit) & 1) << (2 * bit + 1));
  return key >>> 0;
};

export function indexDetections(
  sets: { sensor: ThermalSensorId; data: Detections }[],
): ThermalIndex {
  const total = sets.reduce((n, s) => n + s.data.at.length, 0),
    side = 2 ** THERMAL_MAX_ZOOM,
    keys = new Uint32Array(total),
    xs = new Float64Array(total),
    ys = new Float64Array(total);
  let n = 0;
  for (const { data } of sets)
    for (let i = 0; i < data.at.length; i++, n++) {
      const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, data.lat[i])) * (Math.PI / 180);
      xs[n] = Math.min((data.lon[i] + 180) / 360, 1 - 1e-12);
      ys[n] = Math.min(
        Math.max(0, 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)),
        1 - 1e-12,
      );
      keys[n] = morton(Math.floor(xs[n] * side), Math.floor(ys[n] * side));
    }
  const order = Uint32Array.from({ length: total }, (_, i) => i).sort(
    (a, b) => keys[a] - keys[b],
  );
  const index: ThermalIndex = {
    key: new Uint32Array(total),
    x: new Float64Array(total),
    y: new Float64Array(total),
    sensor: new Uint8Array(total),
    at: new Float64Array(total),
    confidence: new Uint8Array(total),
    sensors: sets.map((s) => s.sensor),
  };
  const source = new Uint8Array(total),
    offset = new Uint32Array(total);
  n = 0;
  sets.forEach(({ data }, k) => {
    for (let i = 0; i < data.at.length; i++, n++) {
      source[n] = k;
      offset[n] = i;
    }
  });
  order.forEach((from, to) => {
    const data = sets[source[from]].data,
      i = offset[from];
    index.key[to] = keys[from];
    index.x[to] = xs[from];
    index.y[to] = ys[from];
    index.sensor[to] = source[from];
    index.at[to] = data.at[i];
    index.confidence[to] = data.confidence[i];
  });
  return index;
}

/** Detections inside tile z/x/y: a contiguous run of the Morton-sorted index. */
function range(index: ThermalIndex, z: number, x: number, y: number) {
  const shift = 2 * (THERMAL_MAX_ZOOM - z),
    first = morton(x, y) * 2 ** shift,
    end = first + 2 ** shift;
  const bound = (value: number) => {
    let lo = 0,
      hi = index.key.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.key[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return [bound(first), bound(end)] as const;
}

/** Every tile holding at least one detection, coarsest zoom first. */
export function* occupiedTiles(index: ThermalIndex) {
  for (let z = 0; z <= THERMAL_MAX_ZOOM; z++) {
    const shift = 2 * (THERMAL_MAX_ZOOM - z);
    for (let i = 0; i < index.key.length; ) {
      const prefix = Math.floor(index.key[i] / 2 ** shift);
      let x = 0,
        y = 0;
      for (let bit = 0; bit < z; bit++) {
        x |= ((prefix >> (2 * bit)) & 1) << bit;
        y |= ((prefix >> (2 * bit + 1)) & 1) << bit;
      }
      yield [z, x, y] as const;
      i = range(index, z, x, y)[1];
    }
  }
}

/** Protocol buffer output in one growing buffer; nested messages are written in place. */
class Writer {
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array(4096);
  length = 0;
  private reserve(n: number) {
    if (this.length + n <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + n));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }
  varint(value: number) {
    this.reserve(10);
    while (value > 127) {
      this.bytes[this.length++] = (value % 128) | 128;
      value = Math.floor(value / 128);
    }
    this.bytes[this.length++] = value;
  }
  tag(field: number, wire: number) {
    this.varint(field * 8 + wire);
  }
  string(field: number, value: string) {
    this.message(field, () => {
      const bytes = text.encode(value);
      this.reserve(bytes.length);
      this.bytes.set(bytes, this.length);
      this.length += bytes.length;
    });
  }
  /** A length-delimited field: one byte is reserved for the length and the body moves if it needs more. */
  message(field: number, write: () => void) {
    this.tag(field, 2);
    this.reserve(1);
    const start = ++this.length;
    write();
    let size = this.length - start,
      extra = 0;
    for (let v = size; v > 127; v = Math.floor(v / 128)) extra++;
    if (extra) {
      this.reserve(extra);
      this.bytes.copyWithin(start + extra, start, this.length);
      this.length += extra;
    }
    let at = start - 1;
    for (; size > 127; size = Math.floor(size / 128))
      this.bytes[at++] = (size % 128) | 128;
    this.bytes[at] = size;
  }
}
const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const text = new TextEncoder();

/** A one-layer tile; each feature is a point or multipoint given as flat x, y pairs. */
function layer(
  name: string,
  keys: string[],
  features: { tags: number[]; points: number[] }[],
  values: (string | number)[],
) {
  const out = new Writer();
  out.message(3, () => {
    out.tag(15, 0);
    out.varint(2);
    out.string(1, name);
    for (const { tags, points } of features)
      out.message(2, () => {
        out.message(2, () => tags.forEach((t) => out.varint(t)));
        out.tag(3, 0);
        out.varint(1);
        out.message(4, () => {
          out.varint(1 | ((points.length / 2) << 3));
          for (let i = 0; i < points.length; i += 2) {
            out.varint(zigzag(points[i] - (i ? points[i - 2] : 0)));
            out.varint(zigzag(points[i + 1] - (i ? points[i - 1] : 0)));
          }
        });
      });
    for (const key of keys) out.string(3, key);
    for (const value of values)
      out.message(4, () => {
        if (typeof value === "string") out.string(1, value);
        else {
          out.tag(5, 0);
          out.varint(value);
        }
      });
    out.tag(5, 0);
    out.varint(EXTENT);
  });
  return out.bytes.slice(0, out.length);
}

/** The tile's bytes, or null when no detection falls inside it. */
export function encodeThermalTile(
  index: ThermalIndex,
  z: number,
  x: number,
  y: number,
): Uint8Array<ArrayBuffer> | null {
  const [first, end] = range(index, z, x, y);
  if (first === end) return null;
  const scale = 2 ** z,
    px = (i: number) => Math.round((index.x[i] * scale - x) * EXTENT),
    py = (i: number) => Math.round((index.y[i] * scale - y) * EXTENT);
  const values: (string | number)[] = [],
    valueIds = new Map<string | number, number>(),
    value = (v: string | number) => {
      let id = valueIds.get(v);
      if (id === undefined) {
        valueIds.set(v, (id = values.length));
        values.push(v);
      }
      return id;
    };
  if (z < THERMAL_POINT_ZOOM) {
    const count = new Uint32Array(CELLS * CELLS),
      sumX = new Float64Array(CELLS * CELLS),
      sumY = new Float64Array(CELLS * CELLS),
      cellOf = (v: number) => Math.min(CELLS - 1, Math.floor((v * CELLS) / EXTENT));
    for (let i = first; i < end; i++) {
      const tx = px(i),
        ty = py(i),
        cell = cellOf(ty) * CELLS + cellOf(tx);
      count[cell]++;
      sumX[cell] += tx;
      sumY[cell] += ty;
    }
    // One point per cell at the mean position of its detections.
    const features: { tags: number[]; points: number[] }[] = [];
    count.forEach((n, cell) => {
      if (n)
        features.push({
          tags: [0, value(n)],
          points: [Math.round(sumX[cell] / n), Math.round(sumY[cell] / n)],
        });
    });
    return layer("cells", ["n"], features, values);
  }
  // One multipoint per sensor, acquisition minute and confidence.
  const groups = new Map<number, number[]>();
  for (let i = first; i < end; i++) {
    const key =
        Math.floor(index.at[i] / 60000) * 9 + index.sensor[i] * 3 + index.confidence[i],
      points = groups.get(key);
    if (points) points.push(px(i), py(i));
    else groups.set(key, [px(i), py(i)]);
  }
  // Oldest first, so the newest pass draws on top.
  const features = [...groups.keys()]
    .sort((a, b) => a - b)
    .map((key) => {
      const minute = Math.floor(key / 9),
        sensor = index.sensors[Math.floor((key % 9) / 3)],
        confidence = VIIRS_CONFIDENCE[key % 3];
      return {
        tags: [0, value(sensor), 1, value(minute * 60), 2, value(confidence)],
        points: groups.get(key)!,
      };
    });
  return layer("detections", ["sensor", "at", "confidence"], features, values);
}
