// One PMTiles archive of every thermal detection for the static public demo,
// read by the browser with HTTP range requests.
import { gzipSync } from "node:zlib";
import {
  THERMAL_MAX_ZOOM,
  THERMAL_POINT_ZOOM,
} from "../shared/geospatial";
import { tileId, writeArchive } from "../shared/pmtiles";
import {
  encodeThermalTile,
  occupiedTiles,
  type ThermalIndex,
} from "../server/thermal-tiles";

export function thermalArchive(index: ThermalIndex) {
  const tiles = [...occupiedTiles(index)]
    .map(([z, x, y]) => ({
      id: tileId(z, x, y),
      data: gzipSync(encodeThermalTile(index, z, x, y)!),
    }))
    .sort((a, b) => a.id - b.id);
  return writeArchive(
    tiles,
    {
      vector_layers: [
        { id: "cells", minzoom: 0, maxzoom: THERMAL_POINT_ZOOM - 1, fields: { n: "Number" } },
        {
          id: "detections",
          minzoom: THERMAL_POINT_ZOOM,
          maxzoom: THERMAL_MAX_ZOOM,
          fields: { sensor: "String", at: "Number", confidence: "String" },
        },
      ],
      detections: index.key.length,
      attribution: "NASA FIRMS / LANCE / EOSDIS",
    },
    [0, THERMAL_MAX_ZOOM],
    (bytes) => gzipSync(bytes),
  );
}
