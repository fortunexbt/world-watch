import type { EventClaim, JobInput, IncidentView } from "../shared/contracts";
import places from "../shared/gazetteer.json";
import countries from "../shared/countries.json";
const key = (v: string) => v.normalize("NFC").toLocaleLowerCase().trim();
type City = {
  id: string;
  name: string;
  aliases: string[];
  country: string;
  admin: string;
  lon: number;
  lat: number;
};
const names = new Map<string, City[]>(),
  aliases = new Map<string, City[]>();
const add = (map: Map<string, City[]>, k: string, city: City) => {
  const list = map.get(k);
  if (list) list.push(city);
  else map.set(k, [city]);
};
// Indexed in global scope, which Workers bill to startup rather than to request CPU.
for (const row of places) {
  const [id, name, country, admin, lat, lon, alternates] = row.split("|");
  const city = {
    id,
    name,
    aliases: alternates ? alternates.split(",") : [],
    country,
    admin,
    lon: Number(lon),
    lat: Number(lat),
  };
  add(names, key(name), city);
  for (const alias of new Set(city.aliases.map(key))) add(aliases, alias, city);
}
function cityCandidates(p: EventClaim["places"][number]) {
  const direct = names.get(key(p.name)) ?? [];
  const exact = direct.filter((c) => !p.country || c.country === p.country);
  const options = exact.length
    ? exact
    : (aliases.get(key(p.name)) ?? []).filter(
        (c) => !p.country || c.country === p.country,
      );
  const admin = p.admin && options.filter((c) => c.admin === p.admin);
  return admin && admin.length ? admin : options;
}
type Location = NonNullable<IncidentView["location"]>;
/** Whole-name matching avoids substrings such as Rome in Jerome. No fuzzy geocoding. */
function mentions(text: string, name: string) {
  const needle = key(name);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(key(text));
}
function citedText(p: EventClaim["places"][number], input: JobInput) {
  const ids = new Set(p.evidence_ids);
  return input.excerpts
    .filter((e) => ids.has(e.id))
    .map((e) => e.text)
    .join("\n");
}
function cityLocation(c: City): Location {
  return {
    name: c.name,
    country: c.country,
    lon: c.lon,
    lat: c.lat,
    accuracy: "city",
    radius_km: 8,
  };
}
/** Every marker has a unique exact city match and source evidence; unresolved places remain unresolved. */
export function resolveClaimLocations(
  claim: EventClaim,
  input: JobInput,
): Location[] {
  // MIT's strike calendar identifies regions/provinces and operators, not municipal event geometry.
  // A province or a company's city suffix cannot justify a city-centre incident marker.
  if (input.source_id === "it-mit-strikes" && !input.source_geo) return [];
  const resolved = claim.places.flatMap((p) => {
    const text = citedText(p, input);
    const options = cityCandidates(p);
    const supported = (c: City) =>
      [c.name, ...c.aliases].some((n) => n.length >= 3 && mentions(text, n));
    if (options.length === 1 && supported(options[0])) return [options[0]];
    // Model admin fields sometimes contain an explicit parent city rather than a numeric admin code.
    // Accept it only as a separate exact, source-quoted city and only when the place itself is unresolved.
    if (!options.length && p.admin && mentions(text, p.admin)) {
      const parents = cityCandidates({ ...p, name: p.admin, admin: null });
      if (parents.length === 1 && supported(parents[0])) return [parents[0]];
    }
    return [];
  });
  const unique = [...new Map(resolved.map((c) => [c.id, c])).values()];
  if (input.source_geo) {
    const g = input.source_geo;
    const sourceNamed =
      claim.places.length > 0 &&
      claim.places.every((p) => key(p.name) === key(g.name));
    const supported =
      unique.length > 0 &&
      unique.every(
        (c) =>
          Math.hypot(
            (c.lon - g.lon) * Math.cos((g.lat * Math.PI) / 180),
            c.lat - g.lat,
          ) *
            111 <=
          (g.radius_km ?? (g.accuracy === "city" ? 12 : 0)),
      );
    if (!claim.places.length || sourceNamed || supported)
      return [
        {
          ...g,
          country:
            unique.length === 1
              ? unique[0].country
              : (claim.places[0]?.country ?? null),
          radius_km:
            g.radius_km ??
            (g.accuracy === "city"
              ? 8
              : g.accuracy === "country"
                ? 200
                : g.accuracy === "area"
                  ? 20
                  : 0),
        },
      ];
  }
  if (unique.length) return unique.map(cityLocation);
  // Country centroids are coarse country scope only, never cities or precise points.
  const matched = claim.places.flatMap((p) =>
    countries.filter(
      (c) =>
        (!p.country || p.country === c.country) &&
        [c.name, ...c.aliases].some((a) => key(a) === key(p.name)) &&
        mentions(citedText(p, input), p.name),
    ),
  );
  return [...new Map(matched.map((c) => [c.country, c])).values()].map((c) => ({
    name: c.name,
    country: c.country,
    lon: c.lon,
    lat: c.lat,
    accuracy: "country" as const,
    radius_km: c.radius_km,
  }));
}
/** Legacy single-location callers must not collapse a multi-city claim into a centroid. */
export function resolveClaimLocation(
  claim: EventClaim,
  input: JobInput,
): IncidentView["location"] {
  const locations = resolveClaimLocations(claim, input);
  // The legacy single-pin view cannot represent two distinct named cities.
  const namedCities = new Set(claim.places.flatMap(p=>cityCandidates(p)).map(c=>c.id));
  return locations.length === 1 && namedCities.size <= 1 ? locations[0] : null;
}
/** Bounding boxes are [west, south, east, north]; west > east crosses the antimeridian. */
export function inBbox(location: IncidentView["location"], bbox: number[]) {
  if (!location) return false;
  const radius = location.radius_km / 111;
  const lonRadius =
    radius / Math.max(0.05, Math.cos((location.lat * Math.PI) / 180));
  return (
    location.lat + radius >= bbox[1] &&
    location.lat - radius <= bbox[3] &&
    lonOverlaps(location.lon, lonRadius, bbox[0], bbox[2])
  );
}
/** Whether lon ± reach meets the span running east from west to east, across the antimeridian if needed. */
export function lonOverlaps(
  lon: number,
  reach: number,
  west: number,
  east: number,
) {
  const width = east >= west ? east - west : east - west + 360;
  const offset = (((lon - west) % 360) + 360) % 360;
  return (
    width + 2 * reach >= 360 || offset <= width + reach || offset >= 360 - reach
  );
}
export const locationRadius = "json_extract(view,'$.location.radius_km')";
const latitude = "json_extract(view,'$.location.lat')",
  longitude = "json_extract(view,'$.location.lon')",
  reach = `${locationRadius}/111.0`;
/**
 * SQL superset of inBbox over incidents.view, without trigonometry in SQL. When `banded`, the
 * latitude band padded by the largest stored radius can drive the incidents_latitude index.
 */
export function bboxCandidates(bbox: number[], maxRadiusKm: number) {
  const [west, south, east, north] = bbox,
    pad = maxRadiusKm / 111,
    banded = south - pad > -90 || north + pad < 90,
    edge = Math.min(90, Math.max(Math.abs(south - pad), Math.abs(north + pad))),
    // No row inside the band reaches farther in longitude than its radius times this factor.
    stretch = 1 / Math.max(0.05, Math.cos((edge * Math.PI) / 180)),
    width = Math.min(360, east >= west ? east - west : east - west + 360),
    start = ((((west + 180) % 360) + 360) % 360) - 180;
  return {
    banded,
    sql: `${banded ? `${latitude} BETWEEN ? AND ? AND ` : ""}${latitude}+${reach}>=? AND ${latitude}-${reach}<=? AND ((${longitude}+${reach}*?>=? AND ${longitude}-${reach}*?<=?) OR ${longitude}+${reach}*?>=? OR ${longitude}-${reach}*?<=?)`,
    params: [
      ...(banded ? [south - pad, north + pad] : []),
      south,
      north,
      stretch,
      start,
      stretch,
      start + width,
      stretch,
      start + 360,
      stretch,
      start + width - 360,
    ],
  };
}
