/**
 * Bounds are "west,south,east,north" in degrees with longitudes in [-180, 180].
 * A west value greater than east crosses the antimeridian: "170,-20,-170,0"
 * spans 170°E through 180° to 170°W. "-180,…,180,…" is the whole world.
 */
const span = (west: number, east: number) =>
  east >= west ? east - west : east - west + 360;
const eastOf = (lon: number, origin: number) =>
  (((lon - origin) % 360) + 360) % 360;
export function validBounds(value: string) {
  const b = value.split(",").map(Number);
  return (
    b.length === 4 &&
    b.every(Number.isFinite) &&
    [b[0], b[2]].every((lon) => lon >= -180 && lon <= 180) &&
    b[1] >= -90 &&
    b[3] <= 90 &&
    b[1] < b[3] &&
    span(b[0], b[2]) > 0
  );
}
/** Whether the longitude interval [min, max] meets the west to east range. */
export function longitudeOverlaps(
  west: number,
  east: number,
  min: number,
  max: number,
) {
  const start = eastOf(min, west);
  return start <= span(west, east) || start + (max - min) >= 360;
}
/**
 * Map viewports on wrapped world copies, reduced to the bounds convention above.
 * Five decimals (about 1 m) keep floating-point noise such as 1e-14 out of query
 * strings, which servers parse as plain decimals.
 */
export function viewportBounds(
  west: number,
  south: number,
  east: number,
  north: number,
) {
  const [w, e] =
    east - west >= 360
      ? [-180, 180]
      : [eastOf(west, -180) - 180, 180 - eastOf(180, east)];
  return [w, Math.max(-90, south), e, Math.min(90, north)]
    .map((v) => Number(v.toFixed(5)))
    .join(",");
}
