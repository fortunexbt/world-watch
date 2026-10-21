// Rebuilds src/shared/gazetteer.json and src/shared/countries.json offline.
// Usage: node scripts/gazetteer.mjs path/to/cities15000.txt (unzipped GeoNames dump).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2];
if (!source) throw Error("usage: node scripts/gazetteer.mjs cities15000.txt");
const key = (v) => v.normalize("NFC").toLocaleLowerCase().trim();
const places = readFileSync(source, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const f = line.split("\t");
    return {
      id: f[0],
      name: f[1],
      alternates: [f[2], ...f[3].split(",")],
      lat: f[4],
      lon: f[5],
      feature: f[7],
      country: f[8],
      admin: f[10],
      population: Number(f[14]),
    };
  });

// GeoNames mixes real exonyms with machine romanisations ("pari", "kiv", "dka") that
// match ordinary words; those, numeric codes and concatenation glitches are dropped.
const machineRomanisation = (a) =>
  /^[\p{Script=Latin}\P{L}]+$/u.test(a) && a === a.toLowerCase();
const usable = (a) =>
  /\p{L}/u.test(a) &&
  !a.includes("  ") &&
  !a.includes(",") &&
  !machineRomanisation(a);
const rows = places.map((p) => {
  const seen = new Set([key(p.name)]);
  const aliases = p.alternates.filter(
    (a) => usable(a) && !seen.has(key(a)) && seen.add(key(a)),
  );
  const row = [
    p.id,
    p.name,
    p.country,
    p.admin,
    p.lat,
    p.lon,
    aliases.join(","),
  ];
  if (row.some((field) => field.includes("|")))
    throw Error(`separator in GeoNames ${p.id}`);
  return row.join("|");
});
writeFileSync(
  `${root}src/shared/gazetteer.json`,
  `[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`,
);

const rad = (d) => (d * Math.PI) / 180;
const km = (a, b) =>
  2 *
  6371 *
  Math.asin(
    Math.sqrt(
      Math.sin(rad(b[1] - a[1]) / 2) ** 2 +
        Math.cos(rad(a[1])) *
          Math.cos(rad(b[1])) *
          Math.sin(rad(b[0] - a[0]) / 2) ** 2,
    ),
  );
// Country scope never claims more than the legacy 250 km circle, and never less than a city.
const radius = (centre, points, pad = 0) =>
  Math.min(
    250,
    Math.max(8, Math.ceil(Math.max(...points.map((p) => km(centre, p) + pad)))),
  );
const countries = [];
for (const { properties: p, geometry } of JSON.parse(
  readFileSync(`${root}public/countries.geojson`, "utf8"),
).features) {
  if (!/^[A-Z]{2}$/.test(p.ISO_A2_EH)) continue;
  const centre = [p.LABEL_X, p.LABEL_Y];
  const rings =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  countries.push({
    country: p.ISO_A2_EH,
    name: p.NAME,
    aliases: [
      ...new Set(
        Object.entries(p)
          .filter(([k, v]) => k.startsWith("NAME") && typeof v === "string")
          .map(([, v]) => v),
      ),
    ],
    lon: p.LABEL_X,
    lat: p.LABEL_Y,
    radius_km: radius(centre, rings.flat(2)),
  });
}

// States absent from Natural Earth 1:110m take CLDR names (Node ICU) and a GeoNames capital,
// with a radius covering every cities15000 locality circle of that state.
const languages =
  "ar bn de el en es fa fr he hi hu id it ja ko nl pl pt ru sv tr uk ur vi zh zh-Hant".split(
    " ",
  );
const label = (code, language, style) =>
  new Intl.DisplayNames([language], {
    type: "region",
    style,
    fallback: "none",
  }).of(code);
// CLDR region codes that are not ISO 3166-1 alpha-2 country assignments.
const notCountries = new Set(
  "AC CP CQ DG EA EU EZ IC QO TA UN XA XB ZZ".split(" "),
);
const known = new Set(countries.map((c) => c.country));
const unsourced = [];
for (let a = 65; a <= 90; a++)
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (
      known.has(code) ||
      notCountries.has(code) ||
      !label(code, "en") ||
      Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`
    )
      continue;
    const local = places.filter((p) => p.country === code);
    if (!local.length) {
      unsourced.push(code);
      continue;
    }
    const rank = (p) => (p.feature === "PPLC" ? 1e12 : 0) + p.population;
    const capital = local.reduce((best, p) =>
      rank(p) > rank(best) ? p : best,
    );
    const centre = [Number(capital.lon), Number(capital.lat)];
    countries.push({
      country: code,
      name: label(code, "en", "short"),
      aliases: [
        ...new Set(
          languages
            .flatMap((l) => [label(code, l, "short"), label(code, l, "long")])
            .filter(Boolean),
        ),
      ],
      lon: centre[0],
      lat: centre[1],
      radius_km: radius(
        centre,
        local.map((p) => [Number(p.lon), Number(p.lat)]),
        8,
      ),
    });
  }
writeFileSync(
  `${root}src/shared/countries.json`,
  JSON.stringify(countries, null, 2) + "\n",
);
console.log(
  `${rows.length} places, ${countries.length} countries; no cities15000 locality for ${unsourced.join(" ")}`,
);
