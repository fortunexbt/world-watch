import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeThermalTile,
  indexDetections,
  occupiedTiles,
  type Detections,
} from "../src/server/thermal-tiles.js";
import { thermalArchive } from "../src/public/thermal-archive.js";
import {
  deserializeDirectory,
  findEntry,
  readHeader,
  serializeDirectory,
  tileId,
} from "../src/shared/pmtiles.js";
import { archiveTile } from "../src/client/thermal-tiles.js";
import {
  THERMAL_MAX_ZOOM,
  THERMAL_POINT_ZOOM,
  type ThermalSensorId,
} from "../src/shared/geospatial.js";
import { PUBLIC_FILE_LIMITS, THERMAL_ARCHIVE } from "../src/shared/public-snapshot.js";
import { decodeTile, tileOf } from "./vector-tiles.js";
import { thermalFiles } from "../scripts/synthetic.js";
import { firmsParser, FIRMS_SENSORS } from "../src/server/geospatial.js";

const detections = (points: [lon: number, lat: number, at: number, confidence: number][]): Detections => ({
  lon: Float64Array.from(points, (p) => p[0]),
  lat: Float64Array.from(points, (p) => p[1]),
  at: Float64Array.from(points, (p) => p[2]),
  confidence: Uint8Array.from(points, (p) => p[3]),
});
/** A deterministic pseudo-random sequence, so failures reproduce. */
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
const at = Date.parse("2026-10-23T10:31:00Z");
// Clusters, a sparse background, both sides of the antimeridian, the Mercator limits and exact duplicates.
function synthetic(count: number, seed: number) {
  const r = random(seed),
    points: [number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 10;
    points.push(
      kind < 5
        ? [24 + r() * 4, -15 + r() * 3, at - Math.floor(r() * 30) * 60000, i % 3]
        : kind < 8
          ? [-180 + r() * 360, -60 + r() * 140, at - Math.floor(r() * 1440) * 60000, i % 3]
          : kind === 8
            ? [r() < 0.5 ? 179.999 - r() * 0.5 : -179.999 + r() * 0.5, -17 + r(), at, 2]
            : [r() < 0.5 ? 12.5 : -45, r() < 0.5 ? 89.9 : -89.9, at, 1],
    );
  }
  return points;
}
const sets = (points: [number, number, number, number][]) => {
  const sensors: ThermalSensorId[] = ["noaa-20-viirs", "noaa-21-viirs", "snpp-viirs"];
  return sensors.map((sensor, k) => ({
    sensor,
    data: detections(points.filter((_, i) => i % 3 === k)),
  }));
};

test("every zoom's tiles count every detection once: cells below the point zoom, single detections from it", () => {
  const points = synthetic(6000, 7),
    index = indexDetections(sets(points));
  const counted = new Map<number, number>();
  for (const [z, x, y] of occupiedTiles(index)) {
    const tile = decodeTile(encodeThermalTile(index, z, x, y)!, z, x, y);
    assert.deepEqual(tile.layers, [z < THERMAL_POINT_ZOOM ? "cells" : "detections"]);
    const n =
      z < THERMAL_POINT_ZOOM
        ? tile.cells.reduce((sum, c) => sum + c.n, 0)
        : tile.detections.length;
    assert(n > 0, `${z}/${x}/${y} is listed but empty`);
    counted.set(z, (counted.get(z) ?? 0) + n);
  }
  assert.deepEqual(
    [...counted],
    Array.from({ length: THERMAL_MAX_ZOOM + 1 }, (_, z) => [z, points.length]),
  );
  // Brute force: the listed tiles at z3 are exactly those some detection falls in.
  const expected = new Set(points.map(([lon, lat]) => tileOf(lon, Math.max(-85.0511, Math.min(85.0511, lat)), 3).join("/")));
  assert.deepEqual(
    new Set([...occupiedTiles(index)].filter(([z]) => z === 3).map(([, x, y]) => `${x}/${y}`)),
    expected,
  );
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++)
      assert.equal(encodeThermalTile(index, 3, x, y) === null, !expected.has(`${x}/${y}`));
});

test("detections keep their sensor, acquisition time, confidence and position, either side of the antimeridian", () => {
  const index = indexDetections([
    { sensor: "noaa-21-viirs", data: detections([[179.9, -17.8, at, 2], [179.9, -17.8, at, 2]]) },
    { sensor: "snpp-viirs", data: detections([[-179.9, -17.9, at - 3600000, 0]]) },
  ]);
  for (let z = THERMAL_POINT_ZOOM; z <= THERMAL_MAX_ZOOM; z++) {
    const east = tileOf(179.9, -17.8, z),
      west = tileOf(-179.9, -17.9, z);
    assert.equal(east[0], 2 ** z - 1);
    assert.equal(west[0], 0);
    const e = decodeTile(encodeThermalTile(index, z, ...east)!, z, ...east).detections,
      w = decodeTile(encodeThermalTile(index, z, ...west)!, z, ...west).detections;
    // Two detections at one place stay two.
    assert.equal(e.length, 2);
    assert.deepEqual(
      [e[0].sensor, e[0].confidence, e[0].at, w[0].sensor, w[0].confidence, w[0].at],
      ["noaa-21-viirs", "high", at / 1000, "snpp-viirs", "low", at / 1000 - 3600],
    );
    // Tile precision: 360 degrees over 2^z tiles of 4,096 units.
    const tolerance = 360 / 2 ** z / 4096;
    assert(Math.abs(e[0].lon - 179.9) <= tolerance && Math.abs(e[0].lat + 17.8) <= tolerance);
    assert(Math.abs(w[0].lon + 179.9) <= tolerance && Math.abs(w[0].lat + 17.9) <= tolerance);
  }
  const world = decodeTile(encodeThermalTile(index, 0, 0, 0)!, 0, 0, 0).cells;
  assert.deepEqual(world.map((c) => c.n).sort(), [1, 2]);
});

test("PMTiles IDs and directories follow the version 3 layout", () => {
  // The same IDs as the reference reader, pmtiles 4.5.0.
  assert.equal(tileId(0, 0, 0), 0);
  assert.equal(tileId(1, 0, 0), 1);
  assert.equal(tileId(1, 0, 1), 2);
  assert.equal(tileId(1, 1, 1), 3);
  assert.equal(tileId(1, 1, 0), 4);
  assert.equal(tileId(2, 0, 0), 5);
  assert.equal(tileId(12, 3423, 1763), 19078479);
  const entries = [
    { tileId: 0, offset: 0, length: 10, runLength: 1 },
    { tileId: 5, offset: 10, length: 20, runLength: 1 },
    { tileId: 9, offset: 100, length: 3, runLength: 2 },
  ];
  assert.deepEqual(deserializeDirectory(serializeDirectory(entries)), entries);
  assert.equal(findEntry(entries, 10)?.offset, 100);
  assert.equal(findEntry(entries, 11), null);
  assert.equal(findEntry(entries, 3), null);
});

/** A static host for one archive, answering Range requests or, like some simple servers, ignoring them. */
function host(files: () => Uint8Array<ArrayBuffer>, ranges: boolean, requests: string[]) {
  return (async (input: any, init: any = {}) => {
    const archive = files(),
      range = new Headers(init.headers).get("range"),
      etag = `"${archive.length}"`;
    requests.push(range ?? "whole");
    const [, a, b] = range!.match(/^bytes=(\d+)-(\d+)$/)!;
    return ranges
      ? new Response(archive.slice(+a, Math.min(+b + 1, archive.length)), { status: 206, headers: { etag } })
      : new Response(archive, { status: 200, headers: { etag } });
  }) as typeof fetch;
}
async function protocolTile(url: string, z: number, x: number, y: number) {
  return (await archiveTile(url, z, x, y)) ?? new Uint8Array();
}

test("the browser reads tiles through every leaf directory of an archive, by Range or from a whole-file reply", async () => {
  const points = synthetic(30000, 11),
    index = indexDetections(sets(points)),
    archive = thermalArchive(index),
    header = readHeader(archive);
  assert(header.leafLength > 0, "enough tiles to need leaf directories");
  assert.equal(header.maxZoom, THERMAL_MAX_ZOOM);
  const original = globalThis.fetch;
  try {
    for (const ranges of [true, false]) {
      const requests: string[] = [],
        url = `https://demo.invalid/data/thermal.pmtiles?v=${ranges}`;
      globalThis.fetch = host(() => archive, ranges, requests);
      // About 300 tiles spread along the tile ID order, so every leaf directory is read.
      const tiles = [...occupiedTiles(index)].sort((a, b) => tileId(...a) - tileId(...b)),
        sample = tiles.filter((_, i) => i % Math.ceil(tiles.length / 300) === 0);
      for (const [z, x, y] of sample)
        assert.deepEqual(await protocolTile(url, z, x, y), encodeThermalTile(index, z, x, y));
      assert.equal((await protocolTile(url, 9, 0, 511)).length, 0, "a tile with no detections is empty");
      // Without Range support the whole file arrives once and later tiles read from memory.
      if (!ranges) assert.equal(requests.length, 1);
      else assert(requests.length > sample.length);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("a deployment that replaces the archive mid-session is read again from its new directory", async () => {
  const before = thermalArchive(indexDetections(sets(synthetic(300, 1)))),
    afterIndex = indexDetections(sets(synthetic(500, 2))),
    after = thermalArchive(afterIndex);
  let current = before;
  const original = globalThis.fetch,
    url = "https://demo.invalid/data/thermal.pmtiles?v=replaced";
  globalThis.fetch = host(() => current, true, []);
  try {
    await protocolTile(url, 0, 0, 0);
    current = after;
    assert.deepEqual(await protocolTile(url, 0, 0, 0), encodeThermalTile(afterIndex, 0, 0, 0));
  } finally {
    globalThis.fetch = original;
  }
});

test("a reference day of 200,000 detections fits the public archive ceiling, with every tile under 128 KiB", () => {
  const now = Date.now(),
    files = thermalFiles(200000, 7, now),
    parsed = FIRMS_SENSORS.map((sensor, k) => {
      const parser = firmsParser(sensor, now);
      parser.push(files[k]);
      return { sensor: sensor.id, data: parser.end() };
    }),
    index = indexDetections(parsed);
  assert(index.key.length > 190000);
  const archive = thermalArchive(index);
  assert(archive.length < PUBLIC_FILE_LIMITS[THERMAL_ARCHIVE], `${archive.length} bytes`);
  for (const [z, x, y] of occupiedTiles(index))
    assert(encodeThermalTile(index, z, x, y)!.length < 128 * 1024, `${z}/${x}/${y}`);
});
