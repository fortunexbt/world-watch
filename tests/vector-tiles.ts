// Decodes thermal tiles with the vector tile reader MapLibre itself uses.
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

/** The tile at zoom z holding lon, lat. */
export function tileOf(lon: number, lat: number, z: number) {
  const n = 2 ** z,
    r = (lat * Math.PI) / 180;
  return [
    Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)),
    Math.min(n - 1, Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)),
  ] as const;
}

export function decodeTile(bytes: Uint8Array, z: number, x: number, y: number) {
  const tile = new VectorTile(new PbfReader(bytes));
  const cells: { n: number; lon: number; lat: number }[] = [],
    detections: {
      sensor: string;
      at: number;
      confidence: string;
      lon: number;
      lat: number;
    }[] = [];
  const read = (name: string, each: (p: any, lon: number, lat: number) => void) => {
    const layer = tile.layers[name];
    for (let i = 0; layer && i < layer.length; i++) {
      const feature = layer.feature(i),
        g = feature.toGeoJSON(x, y, z).geometry as any;
      for (const [lon, lat] of g.type === "Point" ? [g.coordinates] : g.coordinates)
        each(feature.properties, lon, lat);
    }
  };
  read("cells", (p, lon, lat) => cells.push({ n: p.n, lon, lat }));
  read("detections", (p, lon, lat) =>
    detections.push({ sensor: p.sensor, at: p.at, confidence: p.confidence, lon, lat }),
  );
  return { layers: Object.keys(tile.layers), cells, detections };
}
