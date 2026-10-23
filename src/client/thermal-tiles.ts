// MapLibre's "thermal" protocol: tiles from the owner API, or in the public demo
// from the static PMTiles archive read with range requests.
import type { AddProtocolAction } from "maplibre-gl";
import {
  deserializeDirectory,
  findEntry,
  FIRST_READ,
  readHeader,
  tileId,
  type Entry,
  type Header,
} from "../shared/pmtiles";
import { THERMAL_ARCHIVE } from "../shared/public-snapshot";

export const thermalTileUrl = (version: string) =>
  `thermal://${version}/{z}/{x}/{y}`;

type Archive = {
  header: Header;
  root: Entry[];
  etag: string | null;
  /** The whole file, when the server answered a range request with all of it. */
  whole?: Uint8Array;
  leaves: Map<number, Promise<Entry[]>>;
};
const archives = new Map<string, Promise<Archive>>();
/** The archive changed on the server between two reads. */
class Replaced extends Error {}

async function gunzip(bytes: Uint8Array<ArrayBuffer>) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** Bytes [offset, offset + length); a server that ignores Range sends the whole file once. */
async function read(
  url: string,
  offset: number,
  length: number,
  archive?: Archive,
) {
  if (archive?.whole)
    return { bytes: archive.whole.slice(offset, offset + length) };
  const r = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (r.status !== 200 && r.status !== 206)
    throw Error(`Thermal archive unavailable (${r.status})`);
  const etag = r.headers.get("etag");
  if (archive && etag !== archive.etag) throw new Replaced();
  const bytes = new Uint8Array(await r.arrayBuffer());
  return r.status === 200
    ? { bytes: bytes.slice(offset, offset + length), whole: bytes, etag }
    : { bytes, etag };
}
function open(url: string) {
  let archive = archives.get(url);
  if (!archive) {
    // The map shows one generation at a time, so an older archive's directories can go.
    archives.clear();
    archive = (async () => {
      const first = await read(url, 0, FIRST_READ);
      const header = readHeader(first.bytes);
      return {
        header,
        root: deserializeDirectory(
          await gunzip(
            first.bytes.slice(
              header.rootOffset,
              header.rootOffset + header.rootLength,
            ),
          ),
        ),
        etag: first.etag ?? null,
        whole: first.whole,
        leaves: new Map(),
      };
    })();
    archives.set(url, archive);
    archive.catch(() => archives.delete(url));
  }
  return archive;
}
async function tile(url: string, z: number, x: number, y: number) {
  const archive = await open(url),
    id = tileId(z, x, y);
  let entries = archive.root;
  for (let depth = 0; depth < 4; depth++) {
    const entry = findEntry(entries, id);
    if (!entry) return null;
    if (entry.runLength) {
      const offset = archive.header.dataOffset + entry.offset;
      return gunzip(
        (await read(url, offset, entry.length, archive)).bytes,
      );
    }
    let leaf = archive.leaves.get(entry.offset);
    if (!leaf) {
      const offset = archive.header.leafOffset + entry.offset;
      leaf = read(url, offset, entry.length, archive)
        .then(({ bytes }) => gunzip(bytes))
        .then(deserializeDirectory);
      archive.leaves.set(entry.offset, leaf);
      leaf.catch(() => archive.leaves.delete(entry.offset));
    }
    entries = await leaf;
  }
  throw Error("Thermal archive directory too deep");
}

/** One tile of the archive at url; null when it holds no detection. */
export async function archiveTile(url: string, z: number, x: number, y: number) {
  try {
    return await tile(url, z, x, y);
  } catch (error) {
    if (!(error instanceof Replaced)) throw error;
    // A deployment replaced the file mid-session: start again from its new directory.
    archives.delete(url);
    return tile(url, z, x, y);
  }
}
async function load(version: string, z: number, x: number, y: number) {
  if (__PUBLIC_DEMO__)
    return archiveTile(
      new URL(
        `${import.meta.env.BASE_URL}data/${THERMAL_ARCHIVE}?v=${version}`,
        location.href,
      ).href,
      z,
      x,
      y,
    );
  const r = await fetch(`/api/thermal/${version}/${z}/${x}/${y}`, {
    credentials: "same-origin",
  });
  if (!r.ok) throw Error(`Thermal tiles unavailable (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
const reading = new Map<string, Promise<ArrayBuffer>>();
/**
 * Answers thermal://<version>/{z}/{x}/{y}; a tile with no detections is empty. Reads are not
 * aborted, because each world copy on screen asks for the same tile at once and they share one.
 */
export const thermalProtocol: AddProtocolAction = async ({ url }) => {
  const [, version, z, x, y] = url.match(
    /^thermal:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)$/,
  )!;
  let read = reading.get(url);
  if (!read) {
    read = load(version, +z, +x, +y)
      .then((data) => data?.buffer ?? new ArrayBuffer(0))
      .finally(() => reading.delete(url));
    reading.set(url, read);
  }
  // Each request gets its own copy, since MapLibre may transfer it to a worker.
  return { data: (await read).slice(0) };
};
