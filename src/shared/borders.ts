import borders from "./borders.json";

type Polygon = number[][][];
/**
 * Natural Earth 1:110m generalises coasts and borders by tens of kilometres. Of 33,806 GeoNames localities,
 * the 309 drawn inside another country were all nearer than this to its edge, except Simferopol: this
 * edition draws Crimea inside Russia. Anything nearer an edge stays unassigned.
 */
const MARGIN_KM = 40;
const countries = (borders as [string, Polygon[]][]).map(([code, polygons]) => {
  const points = polygons.flat(2);
  return {
    code,
    polygons,
    west: Math.min(...points.map((p) => p[0])),
    east: Math.max(...points.map((p) => p[0])),
    south: Math.min(...points.map((p) => p[1])),
    north: Math.max(...points.map((p) => p[1])),
  };
});
const inside = (polygon: Polygon, lon: number, lat: number) => {
  let odd = false;
  for (const ring of polygon)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i],
        [x2, y2] = ring[j];
      if (y1 > lat !== y2 > lat && lon < x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1))
        odd = !odd;
    }
  return odd;
};
/** Equirectangular distance to a segment, accurate enough at the margin's scale. */
const segmentKm = (lon: number, lat: number, a: number[], b: number[]) => {
  const k = Math.cos((lat * Math.PI) / 180) * 111.32;
  const east = (x: number) => ((((x - lon) % 360) + 540) % 360) - 180;
  const ax = east(a[0]) * k,
    ay = (a[1] - lat) * 110.57,
    bx = east(b[0]) * k,
    by = (b[1] - lat) * 110.57;
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(
    0,
    Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(ax + t * dx, ay + t * dy);
};

/** ISO 3166-1 alpha-2 code of the country containing a point, or null offshore, near a coast or border, or in an uncoded territory. */
export function countryAt(lon: number, lat: number): string | null {
  for (const c of countries) {
    if (lon < c.west || lon > c.east || lat < c.south || lat > c.north)
      continue;
    if (!c.polygons.some((p) => inside(p, lon, lat))) continue;
    const nearEdge = c.polygons.some((polygon) =>
      polygon.some((ring) =>
        ring.some(
          (a, i) =>
            i > 0 &&
            // Natural Earth splits countries at the antimeridian; that cut is not a border.
            !(Math.abs(a[0]) === 180 && a[0] === ring[i - 1][0]) &&
            segmentKm(lon, lat, ring[i - 1], a) < MARGIN_KM,
        ),
      ),
    );
    return nearEdge ? null : c.code;
  }
  return null;
}

/** The country's largest polygon. A box around every part would centre France in the Atlantic, between Europe and French Guiana. */
export function mainland(country: string) {
  // Shoelace area with longitude scaled at the ring's first latitude; only the ranking matters.
  const size = (ring: number[][]) => {
    const [x0, y0] = ring[0],
      k = Math.cos((y0 * Math.PI) / 180);
    let sum = 0;
    for (let i = 1; i < ring.length; i++)
      sum +=
        (ring[i - 1][0] - x0) * k * (ring[i][1] - y0) -
        (ring[i][0] - x0) * k * (ring[i - 1][1] - y0);
    return Math.abs(sum);
  };
  return countries
    .find((c) => c.code === country)?.polygons
    .reduce((a, b) => (size(b[0]) > size(a[0]) ? b : a));
}
