// Rebuilds src/shared/borders.json offline from the map's Natural Earth 1:110m countries.
// Usage: node scripts/borders.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const rows = [];
for (const { properties: p, geometry } of JSON.parse(
  readFileSync(`${root}public/countries.geojson`, "utf8"),
).features) {
  // Northern Cyprus and Somaliland carry no code, so points there keep a null country.
  if (!/^[A-Z]{2}$/.test(p.ISO_A2_EH)) continue;
  rows.push([
    p.ISO_A2_EH,
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates,
  ]);
}
writeFileSync(
  `${root}src/shared/borders.json`,
  `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`,
);
console.log(`${rows.length} countries`);
