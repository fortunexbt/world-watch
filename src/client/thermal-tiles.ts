// Where the map reads thermal tiles: the owner API, or in the public demo the
// static PMTiles archive through MapLibre's "pmtiles" protocol.
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

export function thermalTileUrl(version: string) {
  if (!__PUBLIC_DEMO__)
    return `${location.origin}/api/thermal/${version}/{z}/{x}/{y}`;
  const archive = new URL(
    `${import.meta.env.BASE_URL}data/${THERMAL_ARCHIVE}?v=${version}`,
    location.href,
  );
  return `pmtiles://${archive}/{z}/{x}/{y}`;
}

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
  signal?: AbortSignal,
) {
  if (archive?.whole)
    return { bytes: archive.whole.slice(offset, offset + length) };
  const r = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    signal,
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
// The header and directories serve every tile, so no single tile's abort cancels their reads.
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
async function tile(
  url: string,
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
) {
  const archive = await open(url),
    id = tileId(z, x, y);
  let entries = archive.root;
  for (let depth = 0; depth < 4; depth++) {
    const entry = findEntry(entries, id);
    if (!entry) return null;
    if (entry.runLength) {
      const offset = archive.header.dataOffset + entry.offset;
      return gunzip(
        (await read(url, offset, entry.length, archive, signal)).bytes,
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

/** Answers pmtiles://<archive URL>/{z}/{x}/{y}; a tile with no detections is empty. */
export const pmtilesProtocol: AddProtocolAction = async (params, abort) => {
  const [, url, z, x, y] = params.url.match(
    /^pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/,
  )!;
  const load = () => tile(url, +z, +x, +y, abort.signal);
  let data: Uint8Array<ArrayBuffer> | null;
  try {
    data = await load();
  } catch (error) {
    if (!(error instanceof Replaced)) throw error;
    // A deployment replaced the file mid-session: start again from its new directory.
    archives.delete(url);
    data = await load();
  }
  return { data: data ? data.buffer : new ArrayBuffer(0) };
};
