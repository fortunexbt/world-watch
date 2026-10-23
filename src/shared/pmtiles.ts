// PMTiles version 3 (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md):
// the subset this app writes and reads. Tiles and directories are gzip-compressed
// vector tiles, addressed by Hilbert tile ID, with leaf directories once the root
// directory outgrows the archive's first 16 KiB.
export const HEADER_BYTES = 127,
  FIRST_READ = 16384;
const GZIP = 2,
  MVT = 1;
export type Entry = {
  tileId: number;
  offset: number;
  length: number;
  /** 0 marks a leaf directory, otherwise how many consecutive tile IDs share the bytes. */
  runLength: number;
};
export type Header = {
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  leafLength: number;
  dataOffset: number;
  dataLength: number;
  tiles: number;
  minZoom: number;
  maxZoom: number;
};

/** Tiles of every coarser zoom, then the Hilbert curve position within zoom z. */
export function tileId(z: number, x: number, y: number) {
  let id = (4 ** z - 1) / 3;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = x & s ? 1 : 0,
      ry = y & s ? 1 : 0;
    id += s * s * ((3 * rx) ^ ry);
    if (!ry) {
      if (rx) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return id;
}

function varints(values: number[]) {
  const out: number[] = [];
  for (let v of values) {
    while (v > 127) {
      out.push((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    out.push(v);
  }
  return out;
}
export function serializeDirectory(entries: Entry[]) {
  return Uint8Array.from(
    varints([
      entries.length,
      ...entries.map((e, i) => e.tileId - (i ? entries[i - 1].tileId : 0)),
      ...entries.map((e) => e.runLength),
      ...entries.map((e) => e.length),
      ...entries.map((e, i) =>
        i && e.offset === entries[i - 1].offset + entries[i - 1].length
          ? 0
          : e.offset + 1,
      ),
    ]),
  );
}
export function deserializeDirectory(bytes: Uint8Array): Entry[] {
  let pos = 0;
  const next = () => {
    let value = 0;
    for (let shift = 1; ; shift *= 128) {
      if (pos >= bytes.length) throw Error("pmtiles_directory");
      const b = bytes[pos++];
      value += (b & 127) * shift;
      if (b < 128) return value;
    }
  };
  const n = next(),
    entries: Entry[] = [];
  for (let i = 0, id = 0; i < n; i++)
    entries.push({ tileId: (id += next()), offset: 0, length: 0, runLength: 0 });
  for (const e of entries) e.runLength = next();
  for (const e of entries) e.length = next();
  entries.forEach((e, i) => {
    const v = next();
    e.offset = v ? v - 1 : entries[i - 1].offset + entries[i - 1].length;
  });
  return entries;
}
/** The entry holding tileId: a tile or the leaf directory to read next. */
export function findEntry(entries: Entry[], id: number) {
  let lo = 0,
    hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].tileId <= id) lo = mid + 1;
    else hi = mid - 1;
  }
  const e = entries[hi];
  return e && (e.runLength === 0 || id - e.tileId < e.runLength) ? e : null;
}

const u64 = (view: DataView, at: number) =>
  view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
export function readHeader(bytes: Uint8Array): Header {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < HEADER_BYTES ||
    new TextDecoder().decode(bytes.subarray(0, 7)) !== "PMTiles" ||
    bytes[7] !== 3 ||
    bytes[97] !== GZIP ||
    bytes[98] !== GZIP ||
    bytes[99] !== MVT
  )
    throw Error("pmtiles_header");
  return {
    rootOffset: u64(view, 8),
    rootLength: u64(view, 16),
    metadataOffset: u64(view, 24),
    metadataLength: u64(view, 32),
    leafOffset: u64(view, 40),
    leafLength: u64(view, 48),
    dataOffset: u64(view, 56),
    dataLength: u64(view, 64),
    tiles: u64(view, 72),
    minZoom: bytes[100],
    maxZoom: bytes[101],
  };
}

/**
 * Lays out an archive from gzip-compressed tiles, which must be ordered by tile
 * ID. `gzip` compresses the directories and metadata.
 */
export function writeArchive(
  tiles: { id: number; data: Uint8Array }[],
  metadata: object,
  zooms: [min: number, max: number],
  gzip: (bytes: Uint8Array) => Uint8Array,
) {
  const entries: Entry[] = [];
  let offset = 0;
  for (const { id, data } of tiles) {
    entries.push({ tileId: id, offset, length: data.length, runLength: 1 });
    offset += data.length;
  }
  let root = gzip(serializeDirectory(entries)),
    leaves = new Uint8Array(0);
  for (let size = 4096; HEADER_BYTES + root.length > FIRST_READ; size *= 2) {
    const pointers: Entry[] = [],
      parts: Uint8Array[] = [];
    let at = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = gzip(serializeDirectory(entries.slice(i, i + size)));
      pointers.push({ tileId: entries[i].tileId, offset: at, length: leaf.length, runLength: 0 });
      parts.push(leaf);
      at += leaf.length;
    }
    root = gzip(serializeDirectory(pointers));
    leaves = concat(parts);
  }
  const meta = gzip(new TextEncoder().encode(JSON.stringify(metadata))),
    data = concat(tiles.map((t) => t.data));
  const header = new Uint8Array(HEADER_BYTES),
    view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("PMTiles"));
  header[7] = 3;
  const sections = [
    HEADER_BYTES, root.length,
    HEADER_BYTES + root.length, meta.length,
    HEADER_BYTES + root.length + meta.length, leaves.length,
    HEADER_BYTES + root.length + meta.length + leaves.length, data.length,
    tiles.length, tiles.length, tiles.length,
  ];
  sections.forEach((v, i) => {
    view.setUint32(8 + 8 * i, v % 2 ** 32, true);
    view.setUint32(12 + 8 * i, Math.floor(v / 2 ** 32), true);
  });
  header[96] = 1;
  header[97] = GZIP;
  header[98] = GZIP;
  header[99] = MVT;
  header[100] = zooms[0];
  header[101] = zooms[1];
  view.setInt32(102, -180e7, true);
  view.setInt32(106, -85e7, true);
  view.setInt32(110, 180e7, true);
  view.setInt32(114, 85e7, true);
  return concat([header, root, meta, leaves, data]);
}
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
