/**
 * Issuer geometry kept beside an incident's location. The location stays the display anchor and
 * the spatial index key; a footprint is drawn under the markers and decides watch-area alerts when
 * it has an area. Longitudes are unwrapped so every ring and line is continuous across 180°, so
 * they can run past ±180 by less than one turn.
 */
export type Position = [number, number];
export type FootprintGeometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "MultiLineString"; coordinates: Position[][] };
/**
 * advisory_area: the area an issuer's warning applies to (NWS, ECCC).
 * inferred_affected_area: an area an issuer's model derives (GDACS cyclone wind buffers).
 * shaking_intensity: estimated shaking contour lines, never areas (USGS ShakeMap MMI).
 */
export const FOOTPRINT_ROLES = [
  "advisory_area",
  "inferred_affected_area",
  "shaking_intensity",
] as const;
export type FootprintRole = (typeof FOOTPRINT_ROLES)[number];
/** level is the MMI of a ShakeMap contour or the wind speed in km/h of a GDACS buffer; label is the issuer's own. */
export type FootprintPart = {
  geometry: FootprintGeometry;
  level?: number;
  label?: string;
};
/** Every issuer vertex lies within tolerance_km of these parts, rounding included. */
export type FootprintShape = { tolerance_km: number; parts: FootprintPart[] };
export type Footprint = {
  role: FootprintRole;
  /** Where the geometry was read; list views leave it out. */
  source_url?: string;
  /** Simplified for the detail read, alerts and the selected incident; list views leave it out. */
  detail?: FootprintShape;
  /** Coarser copy every list view carries for the map. */
  display: FootprintShape;
};
/** Starting tolerance, position ceiling and coordinate decimals of each copy. */
export const FOOTPRINT_LIMITS = {
  detail: { tolerance_km: 0.25, positions: 600, decimals: 3 },
  display: { tolerance_km: 2, positions: 240, decimals: 2 },
} as const;
/** A shape still over its ceiling at this tolerance is not stored. */
const MAX_TOLERANCE_KM = 64;
/** Degree lengths that never understate a distance: a meridian degree is at most 111.7 km. */
const KM_LAT = 111.7,
  KM_LON = 111.32;
const LABEL_LENGTH = 80;

export const footprintShape = (f: Footprint) => f.detail ?? f.display;
const positions = (g: FootprintGeometry) =>
  (g.type === "MultiPolygon" ? g.coordinates.flat() : g.coordinates).reduce(
    (n, line) => n + line.length,
    0,
  );
export const shapePositions = (s: FootprintShape) =>
  s.parts.reduce((n, p) => n + positions(p.geometry), 0);
const polygons = (g: FootprintGeometry): Position[][][] =>
  g.type === "Polygon"
    ? [g.coordinates]
    : g.type === "MultiPolygon"
      ? g.coordinates
      : [];

const position = (p: unknown): p is Position =>
  Array.isArray(p) &&
  p.length >= 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 360 &&
  Math.abs(p[1]) <= 90;
/** Shifts each position by whole turns so that no step jumps more than 180°, starting near ref. */
function unwrap(line: Position[], ref: number): Position[] {
  let previous = ref;
  return line.map(([lon, lat]) => {
    const x = lon + 360 * Math.round((previous - lon) / 360);
    previous = x;
    return [x, lat];
  });
}
/** Moves a group of lines by whole turns so that its first position lies within ±180°. */
function recentre(lines: Position[][]) {
  const shift = -360 * Math.round(lines[0][0][0] / 360);
  return shift
    ? lines.map((l) => l.map(([x, y]) => [x + shift, y] as Position))
    : lines;
}
function ring(value: unknown, ref: number): Position[] | null {
  if (!Array.isArray(value) || !value.every(position)) return null;
  const line = unwrap(
    value.map((p) => [p[0], p[1]] as Position),
    ref,
  );
  const [a, b] = [line[0], line.at(-1)];
  if (a && b && (a[0] !== b[0] || a[1] !== b[1])) line.push([a[0], a[1]]);
  return line.length >= 4 ? line : null;
}
/** Issuer Polygon, MultiPolygon, LineString or MultiLineString as one part, or null when none of it is usable. */
export function issuerGeometry(geometry: any): FootprintGeometry | null {
  const polygon = (rings: unknown): Position[][] | null => {
    if (!Array.isArray(rings) || !Array.isArray(rings[0])) return null;
    const outer = ring(rings[0], position(rings[0][0]) ? rings[0][0][0] : 0);
    if (!outer) return null;
    const holes = rings
      .slice(1)
      .map((r) => ring(r, outer[0][0]))
      .filter((r): r is Position[] => !!r);
    return recentre([outer, ...holes]);
  };
  const line = (value: unknown): Position[] | null =>
    Array.isArray(value) && value.length >= 2 && value.every(position)
      ? recentre([
          unwrap(
            value.map((p) => [p[0], p[1]] as Position),
            value[0][0],
          ),
        ])[0]
      : null;
  switch (geometry?.type) {
    case "Polygon": {
      const p = polygon(geometry.coordinates);
      return p && { type: "Polygon", coordinates: p };
    }
    case "MultiPolygon": {
      const ps = (
        Array.isArray(geometry.coordinates) ? geometry.coordinates : []
      )
        .map(polygon)
        .filter((p: Position[][] | null): p is Position[][] => !!p);
      return ps.length ? { type: "MultiPolygon", coordinates: ps } : null;
    }
    case "LineString":
    case "MultiLineString": {
      const ls = (
        geometry.type === "LineString"
          ? [geometry.coordinates]
          : Array.isArray(geometry.coordinates)
            ? geometry.coordinates
            : []
      )
        .map(line)
        .filter((l: Position[] | null): l is Position[] => !!l);
      return ls.length ? { type: "MultiLineString", coordinates: ls } : null;
    }
  }
  return null;
}

const closed = (r: Position[]) =>
  r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1];
/** Point to segment distance in km, where scale is the length of a degree of longitude in km. */
function segmentDistance(p: Position, a: Position, b: Position, scale: number) {
  const ax = a[0] * scale,
    ay = a[1] * KM_LAT,
    dx = b[0] * scale - ax,
    dy = b[1] * KM_LAT - ay,
    px = p[0] * scale - ax,
    py = p[1] * KM_LAT - ay,
    length = dx * dx + dy * dy,
    t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}
/**
 * Douglas-Peucker. Every dropped vertex lies within km of the kept segment spanning it, measured
 * with longitude degrees at the line's lowest latitude, which overstates distances elsewhere. A
 * polygon ring keeps at least three corners, so a ring smaller than the tolerance stays a ring; a
 * closed contour line smaller than the tolerance shrinks to its first position.
 */
function simplifyLine(
  line: Position[],
  km: number,
  closed: boolean,
  polygon = closed,
) {
  const n = line.length;
  const scale =
    KM_LON *
    Math.cos((Math.min(...line.map((p) => Math.abs(p[1]))) * Math.PI) / 180);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const farthest = (a: number, b: number) => {
    let at = -1,
      most = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(line[i], line[a], line[b], scale);
      if (d > most) [at, most] = [i, d];
    }
    return { at, most };
  };
  const spans: [number, number][] = [];
  if (closed) {
    const reach = (i: number) =>
      Math.hypot(
        (line[i][0] - line[0][0]) * scale,
        (line[i][1] - line[0][1]) * KM_LAT,
      );
    let corner = 1;
    for (let i = 2; i < n - 1; i++) if (reach(i) > reach(corner)) corner = i;
    if (!polygon && reach(corner) <= km) return [line[0], line[n - 1]];
    keep[corner] = 1;
    const third = [farthest(0, corner), farthest(corner, n - 1)].sort(
      (a, b) => b.most - a.most,
    )[0];
    if (third.at > 0) keep[third.at] = 1;
    spans.push([0, corner], [corner, n - 1]);
  } else spans.push([0, n - 1]);
  while (spans.length) {
    const [a, b] = spans.pop()!;
    const { at, most } = farthest(a, b);
    if (at < 0 || most <= km) continue;
    keep[at] = 1;
    spans.push([a, at], [at, b]);
  }
  return line.filter((_, i) => keep[i]);
}
function simplifyGeometry(
  g: FootprintGeometry,
  km: number,
  decimals: number,
): FootprintGeometry {
  const f = 10 ** decimals;
  const round = (line: Position[]) =>
    line.map(
      ([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f] as Position,
    );
  const rings = (rs: Position[][]) =>
    rs.map((r) => round(simplifyLine(r, km, true)));
  return g.type === "Polygon"
    ? { type: "Polygon", coordinates: rings(g.coordinates) }
    : g.type === "MultiPolygon"
      ? { type: "MultiPolygon", coordinates: g.coordinates.map(rings) }
      : {
          type: "MultiLineString",
          // A contour that closes on itself stays a loop unless it is smaller than the tolerance.
          coordinates: g.coordinates.map((l) =>
            round(simplifyLine(l, km, l.length >= 4 && closed(l), false)),
          ),
        };
}
/** Simplifies at the starting tolerance, doubling it until the shape fits its ceiling. */
function shape(
  parts: FootprintPart[],
  limits: (typeof FOOTPRINT_LIMITS)[keyof typeof FOOTPRINT_LIMITS],
): FootprintShape | null {
  // Rounding moves a position by at most half a grid cell's diagonal.
  const rounding = (0.5 * Math.SQRT2 * KM_LAT) / 10 ** limits.decimals;
  for (let km = limits.tolerance_km; km <= MAX_TOLERANCE_KM; km *= 2) {
    const s = {
      tolerance_km: Math.ceil((km + rounding) * 100) / 100,
      parts: parts.map((p) => ({
        ...p,
        geometry: simplifyGeometry(p.geometry, km, limits.decimals),
      })),
    };
    if (shapePositions(s) <= limits.positions) return s;
  }
  return null;
}
/** A footprint from issuer parts, or null when none is usable or it cannot be bounded. */
export function buildFootprint(
  role: FootprintRole,
  source_url: string,
  parts: { geometry: unknown; level?: number; label?: string }[],
): Footprint | null {
  const usable = parts.flatMap((p) => {
    const geometry = issuerGeometry(p.geometry);
    return geometry
      ? [
          {
            geometry,
            ...(Number.isFinite(p.level) ? { level: p.level } : {}),
            ...(p.label ? { label: p.label.slice(0, LABEL_LENGTH) } : {}),
          },
        ]
      : [];
  });
  if (!usable.length) return null;
  const detail = shape(usable, FOOTPRINT_LIMITS.detail),
    display = shape(usable, FOOTPRINT_LIMITS.display);
  return detail && display ? { role, source_url, detail, display } : null;
}

const continuous = (line: unknown, min: number) =>
  Array.isArray(line) &&
  line.length >= min &&
  line.every(
    (p, i) =>
      Array.isArray(p) &&
      p.length === 2 &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1]) &&
      Math.abs(p[0]) < 540 &&
      Math.abs(p[1]) <= 90 &&
      (i === 0 || Math.abs(p[0] - line[i - 1][0]) <= 180),
  );
const validRings = (rs: unknown) =>
  Array.isArray(rs) &&
  rs.length > 0 &&
  rs.every((r) => continuous(r, 4) && closed(r as Position[]));
function validShape(s: any, limits: { positions: number }) {
  return (
    s &&
    Number.isFinite(s.tolerance_km) &&
    s.tolerance_km >= 0 &&
    s.tolerance_km <= MAX_TOLERANCE_KM * 2 &&
    Array.isArray(s.parts) &&
    s.parts.length > 0 &&
    s.parts.every(
      (p: any) =>
        p &&
        (p.level === undefined || Number.isFinite(p.level)) &&
        (p.label === undefined ||
          (typeof p.label === "string" && p.label.length <= LABEL_LENGTH)) &&
        (p.geometry?.type === "Polygon"
          ? validRings(p.geometry.coordinates)
          : p.geometry?.type === "MultiPolygon"
            ? Array.isArray(p.geometry.coordinates) &&
              p.geometry.coordinates.length > 0 &&
              p.geometry.coordinates.every(validRings)
            : p.geometry?.type === "MultiLineString" &&
              Array.isArray(p.geometry.coordinates) &&
              p.geometry.coordinates.length > 0 &&
              p.geometry.coordinates.every((l: unknown) => continuous(l, 2))),
    ) &&
    shapePositions(s) <= limits.positions
  );
}
/** The ingest check: a known role, continuous closed rings, coordinate ranges and both ceilings. */
export function validFootprint(f: any): f is Required<Footprint> {
  return (
    !!f &&
    FOOTPRINT_ROLES.includes(f.role) &&
    typeof f.source_url === "string" &&
    validShape(f.detail, FOOTPRINT_LIMITS.detail) &&
    validShape(f.display, FOOTPRINT_LIMITS.display)
  );
}

/**
 * A watch area's outer ring with continuous longitudes: a [west, south, east, north] bbox, where
 * west > east crosses 180°, or a Polygon's first ring. Null for anything else.
 */
export function areaRing(geometry: any): Position[] | null {
  const b = geometry?.bbox;
  if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) {
    const east = b[2] < b[0] ? b[2] + 360 : b[2];
    return [
      [b[0], b[1]],
      [east, b[1]],
      [east, b[3]],
      [b[0], b[3]],
      [b[0], b[1]],
    ];
  }
  return geometry?.type === "Polygon"
    ? ring(geometry.coordinates?.[0], geometry.coordinates?.[0]?.[0]?.[0] ?? 0)
    : null;
}
function inside(p: Position, r: Position[]) {
  let hit = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (
      r[i][1] > p[1] !== r[j][1] > p[1] &&
      p[0] <
        ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]
    )
      hit = !hit;
  return hit;
}
const inPolygon = (p: Position, rings: Position[][]) =>
  inside(p, rings[0]) && !rings.slice(1).some((h) => inside(p, h));
const cross = (o: Position, a: Position, b: Position) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segmentsMeet(a: Position, b: Position, c: Position, d: Position) {
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}
/**
 * Whether a watch area comes within the shape's tolerance of its areas, so simplification can
 * only widen a match. Longitude degrees are taken at the highest latitude involved, which never
 * overstates a distance. Null when the shape has no area, as with ShakeMap contour lines.
 */
export function footprintMeetsArea(
  s: FootprintShape,
  area: Position[],
): boolean | null {
  const areas = s.parts.flatMap((p) => polygons(p.geometry));
  if (!areas.length) return null;
  const all = [...areas.flat(2), ...area];
  const scale = Math.max(
    1e-6,
    KM_LON *
      Math.cos((Math.max(...all.map((p) => Math.abs(p[1]))) * Math.PI) / 180),
  );
  const km = s.tolerance_km,
    padX = km / scale,
    padY = km / KM_LAT;
  const box = (ps: Position[]) => [
    Math.min(...ps.map((p) => p[0])),
    Math.min(...ps.map((p) => p[1])),
    Math.max(...ps.map((p) => p[0])),
    Math.max(...ps.map((p) => p[1])),
  ];
  const outer = box(areas.map((rs) => rs[0]).flat());
  for (const turn of [-720, -360, 0, 360, 720]) {
    const ring = area.map(([x, y]) => [x + turn, y] as Position),
      b = box(ring);
    if (
      b[0] > outer[2] + padX ||
      b[2] < outer[0] - padX ||
      b[1] > outer[3] + padY ||
      b[3] < outer[1] - padY
    )
      continue;
    for (const rings of areas) {
      if (
        ring.some((p) => inPolygon(p, rings)) ||
        rings[0].some((p) => inside(p, ring))
      )
        return true;
      for (const r of rings)
        for (let i = 1; i < r.length; i++)
          for (let j = 1; j < ring.length; j++)
            if (
              segmentsMeet(r[i - 1], r[i], ring[j - 1], ring[j]) ||
              Math.min(
                segmentDistance(r[i - 1], ring[j - 1], ring[j], scale),
                segmentDistance(r[i], ring[j - 1], ring[j], scale),
                segmentDistance(ring[j - 1], r[i - 1], r[i], scale),
                segmentDistance(ring[j], r[i - 1], r[i], scale),
              ) <= km
            )
              return true;
    }
  }
  return false;
}
