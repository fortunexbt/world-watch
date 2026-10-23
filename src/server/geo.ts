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
let index:
  { names: Map<string, City[]>; aliases: Map<string, City[]> } | undefined;
export const gazetteerIndexed = () => index !== undefined;
// Built on first lookup, not in global scope, which Workers must finish within one second; that lookup pays it as request CPU.
function gazetteer() {
  if (index) return index;
  const names = new Map<string, City[]>(),
    aliases = new Map<string, City[]>();
  const add = (map: Map<string, City[]>, k: string, city: City) => {
    const list = map.get(k);
    if (list) list.push(city);
    else map.set(k, [city]);
  };
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
    for (const alias of new Set(city.aliases.map(key)))
      add(aliases, alias, city);
  }
  return (index = { names, aliases });
}
function cityCandidates(p: EventClaim["places"][number]) {
  const { names, aliases } = gazetteer();
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
export const locationRadius = "json_extract(view,'$.location.radius_km')";
const latitude = "json_extract(view,'$.location.lat')",
  longitude = "json_extract(view,'$.location.lon')",
  reach = `${locationRadius}/111.0`;
export const eventTime =
    "coalesce(json_extract(view,'$.event_start'),json_extract(view,'$.published_at'))",
  // Latest of start and expiry; '9' sorts timeless and issuer-current incidents after every ISO time, as incidentInWindow keeps them once started.
  windowKey = `CASE WHEN json_extract(view,'$.current_listing') THEN '9' ELSE coalesce(max(${eventTime},coalesce(json_extract(view,'$.expires_at'),${eventTime})),'9') END`;
/** Cells of CELL degrees, numbered row-major from 90° S and 180° W; a last column holds 180° E itself. */
const CELL = 10,
  COLUMNS = 360 / CELL + 1;
/** incidents_cell keys on (locationCell, windowKey); both texts must match its migration exactly. */
export const locationCell = `CAST((${latitude}+90)/${CELL} AS INTEGER)*${COLUMNS}+CAST((${longitude}+180)/${CELL} AS INTEGER)`;
/**
 * SQL superset of inBbox over incidents.view, without trigonometry in SQL, and the grid cells
 * holding every location that can reach the bbox. `cells` is null when they cover the whole grid.
 */
export function bboxCandidates(bbox: number[], maxRadiusKm: number) {
  const [west, south, east, north] = bbox,
    pad = maxRadiusKm / 111,
    edge = Math.min(90, Math.max(Math.abs(south - pad), Math.abs(north + pad))),
    // No row inside the band reaches farther in longitude than its radius times this factor.
    stretch = 1 / Math.max(0.05, Math.cos((edge * Math.PI) / 180)),
    width = Math.min(360, east >= west ? east - west : east - west + 360),
    start = ((((west + 180) % 360) + 360) % 360) - 180;
  const columns = new Set<number>(),
    from = start + 180 - pad * stretch,
    to = start + 180 + width + pad * stretch;
  if (to - from >= 360) for (let c = 0; c < COLUMNS; c++) columns.add(c);
  else
    for (let x = from; ; x += CELL) {
      const at = Math.min(x, to);
      columns.add(Math.floor((((at % 360) + 360) % 360) / CELL));
      if (at === to) break;
    }
  // 180° W and 180° E are one meridian in two columns.
  if (columns.has(0)) columns.add(COLUMNS - 1);
  const first = Math.floor((Math.max(-90, south - pad) + 90) / CELL),
    last = Math.floor((Math.min(90, north + pad) + 90) / CELL),
    cells: number[] = [];
  for (let row = first; row <= last; row++)
    for (const column of columns) cells.push(row * COLUMNS + column);
  return {
    cells: cells.length < (180 / CELL + 1) * COLUMNS ? cells : null,
    sql: `${latitude}+${reach}>=? AND ${latitude}-${reach}<=? AND ((${longitude}+${reach}*?>=? AND ${longitude}-${reach}*?<=?) OR ${longitude}+${reach}*?>=? OR ${longitude}-${reach}*?<=?)`,
    params: [
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
