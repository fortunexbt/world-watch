/**
 * Reduces an issuer's Polygon or MultiPolygon to the centre of its bounding box and a radius
 * reaching its farthest outer-ring vertex. The contract carries points, so the circle covers the
 * issued area rather than tracing it. Longitudes are unwrapped when the area spans the 180° line.
 */
export function polygonArea(
  geometry: any,
): { lon: number; lat: number; radius_km: number } | null {
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : null;
  if (!Array.isArray(polygons)) return null;
  const points: number[][] = polygons.flatMap((p: any) =>
    Array.isArray(p?.[0]) ? p[0] : [],
  );
  if (
    !points.length ||
    points.some(
      (p) =>
        !Array.isArray(p) ||
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 90,
    )
  )
    return null;
  const raw = points.map((p) => p[0]);
  const wraps = Math.max(...raw) - Math.min(...raw) > 180;
  const xs = wraps ? raw.map((x) => (x < 0 ? x + 360 : x)) : raw,
    ys = points.map((p) => p[1]);
  const lon = (Math.min(...xs) + Math.max(...xs)) / 2,
    lat = (Math.min(...ys) + Math.max(...ys)) / 2;
  const radius_km = Math.max(
    ...xs.map(
      (x, i) =>
        111.32 *
        Math.hypot((x - lon) * Math.cos((lat * Math.PI) / 180), ys[i] - lat),
    ),
  );
  return { lon: lon > 180 ? lon - 360 : lon, lat, radius_km };
}
