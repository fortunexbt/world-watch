import type { IncidentLink, IncidentView } from "../shared/contracts";
import { bboxCandidates, locationCell, windowKey } from "./geo";

/**
 * Deterministic same-event linking of structured issuer records. Identity comes from issuer
 * measurements and exact identifiers only; wording never decides it. Bump the version when a
 * tolerance changes, so stored links say which rule wrote them.
 */
export const FUSION_RULE = "fusion-1";
/** Seconds between origin times that still describe one earthquake. */
const QUAKE_SECONDS = 30;
/** Seconds within which an earthquake may still be the same one, or an aftershock. */
const QUAKE_POSSIBLE_SECONDS = 120;
const QUAKE_MAGNITUDE = 0.5;
const QUAKE_POSSIBLE_MAGNITUDE = 1;
/** Agencies place large ruptures farther apart, so the epicentre radius grows above M6. */
const quakeRadius = (magnitude: number) => 25 + 15 * Math.max(0, magnitude - 6);
/** The widest possible-match distance, three radii at M9.5, bounds the candidate read. */
const QUAKE_REACH_KM = 3 * quakeRadius(9.5);
/** A storm renamed into another basin reappears within days, its centre within a day's travel or so. */
const CYCLONE_GAP_DAYS = 2;
const CYCLONE_KM = 1500;
const DAY = 86400000;

type Signature = {
  source: string;
  hazard: "earthquake" | "tropical_cyclone";
  time: number;
  end: number;
  lon: number;
  lat: number;
  magnitude: number | null;
  /** USGS network event IDs, which name the same quake across preferred-ID changes. */
  ids: string[];
  /** Storm name with season, as GDACS writes it, e.g. CHAMPI-26. */
  name: string | null;
  /**
   * Who measured it: the solution's author first, then the catalogue that republishes it, so a
   * record copied from that catalogue shares an origin with it. Empty when the record states none.
   */
  origins: string[];
};
/** NEIC is the USGS National Earthquake Information Center, network code us in ComCat. */
const ORIGIN_ALIAS: Record<string, string> = { USGS: "NEIC", US: "NEIC" };
const originKey = (value: unknown) => {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  return v ? (ORIGIN_ALIAS[v] ?? v) : null;
};
/** An author's solution, and the catalogue carrying it if any; nothing when the author is unstated. */
const carried = (author: unknown, catalogue?: string) => {
  const key = originKey(author);
  return key ? [...new Set(catalogue ? [key, catalogue] : [key])] : [];
};
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The issuer measurements of a live structured record; null for anything else. */
function signature(view: IncidentView): Signature | null {
  const report = view.reports?.[0];
  if (
    view.reports?.length !== 1 ||
    view.analyzed_at ||
    view.evidence_status !== "official_advisory" ||
    view.cancelled ||
    view.superseded_by ||
    !view.location ||
    (view.activity !== "earthquake" && view.activity !== "tropical_cyclone")
  )
    return null;
  let record: any;
  try {
    record = JSON.parse(report.excerpts?.[0]?.text);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  const base = {
    source: report.source_id,
    hazard: view.activity,
    lon: view.location.lon,
    lat: view.location.lat,
  } as const;
  if (view.activity === "earthquake" && typeof record.origin_time === "string") {
    const time = Date.parse(record.origin_time),
      usgs = Array.isArray(record.network_ids);
    return Number.isFinite(time)
      ? {
          ...base,
          time,
          end: time,
          magnitude: finite(record.magnitude),
          ids: usgs
            ? record.network_ids.filter((v: unknown) => typeof v === "string")
            : [],
          name: null,
          // ComCat carries NEIC's solution or a regional network's, which EMSC credits under the
          // same code (AK, TX). EMSC names the author of the solution it carries.
          origins: usgs
            ? carried(record.preferred_network ?? "us", "NEIC")
            : carried(record.author, "EMSC"),
        }
      : null;
  }
  const time = Date.parse(record.from),
    end = Date.parse(record.to);
  if (!Number.isFinite(time)) return null;
  const gdacs = {
    ...base,
    time,
    end: Number.isFinite(end) ? Math.max(end, time) : time,
    ids: [],
    origins: carried(record.hazard_data_source),
  };
  if (view.activity === "earthquake" && record.hazard_type === "EQ")
    return {
      ...gdacs,
      magnitude: record.severity_unit === "M" ? finite(record.severity_value) : null,
      name: null,
    };
  if (
    view.activity === "tropical_cyclone" &&
    record.hazard_type === "TC" &&
    typeof record.event_name === "string" &&
    /^[A-Z][A-Z-]*-\d{2}$/.test(record.event_name.trim().toUpperCase())
  )
    return {
      ...gdacs,
      magnitude: null,
      name: record.event_name.trim().toUpperCase(),
    };
  return null;
}
function kilometres(a: Signature, b: Signature) {
  const rad = Math.PI / 180,
    dLat = (b.lat - a.lat) * rad,
    dLon = (b.lon - a.lon) * rad,
    h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const shared = (a: Signature, b: Signature) =>
  a.origins.find((o) => b.origins.includes(o));
function independence(a: Signature, b: Signature) {
  if (!a.origins.length || !b.origins.length) return "unknown" as const;
  return shared(a, b) ? ("same_origin" as const) : ("independent" as const);
}
const originText = (a: Signature, b: Signature) =>
  a.origins.length && b.origins.length
    ? shared(a, b)
      ? `; both measurements come from ${shared(a, b)}`
      : `; measured by ${a.origins[0]} and ${b.origins[0]}`
    : "; one record states no upstream origin";

/** The rule's verdict on two records, with its reason, or null when nothing relates them. */
export function sameEvent(
  x: IncidentView,
  y: IncidentView,
): Omit<IncidentLink, "incident_id"> | null {
  const a = signature(x),
    b = signature(y);
  if (!a || !b || a.hazard !== b.hazard || x.id === y.id) return null;
  const km = kilometres(a, b);
  if (a.hazard === "earthquake") {
    const shared = a.ids.find((id) => b.ids.includes(id));
    if (shared)
      return {
        type: "same_event",
        independence: "same_origin",
        basis: FUSION_RULE,
        reason: `both USGS records list network event ${shared}`,
      };
    // One issuer's distinct event IDs are distinct earthquakes.
    if (a.source === b.source) return null;
    const seconds = Math.abs(a.time - b.time) / 1000,
      radius = quakeRadius(Math.max(a.magnitude ?? 0, b.magnitude ?? 0)),
      delta =
        a.magnitude !== null && b.magnitude !== null
          ? Math.abs(a.magnitude - b.magnitude)
          : null;
    const facts = `origin times ${Math.round(seconds)} s apart, epicentres ${Math.round(km)} km apart (limit ${radius} km), ${delta === null ? "a magnitude is unstated" : `magnitudes ${delta.toFixed(1)} apart`}${originText(a, b)}`;
    if (
      seconds <= QUAKE_SECONDS &&
      km <= radius &&
      delta !== null &&
      delta <= QUAKE_MAGNITUDE + 1e-9
    )
      return {
        type: "same_event",
        independence: independence(a, b),
        basis: FUSION_RULE,
        reason: facts,
      };
    if (
      seconds <= QUAKE_POSSIBLE_SECONDS &&
      km <= 3 * radius &&
      (delta === null || delta <= QUAKE_POSSIBLE_MAGNITUDE + 1e-9)
    )
      return { type: "possible_same_event", basis: FUSION_RULE, reason: facts };
    return null;
  }
  if (!a.name || a.name !== b.name) return null;
  const days =
    Math.max(0, Math.max(a.time, b.time) - Math.min(a.end, b.end)) / DAY;
  const facts = `both records name ${a.name}; tracks ${days.toFixed(1)} days and ${Math.round(km)} km apart${originText(a, b)}`;
  return days <= CYCLONE_GAP_DAYS && km <= CYCLONE_KM
    ? {
        type: "same_event",
        independence: independence(a, b),
        basis: FUSION_RULE,
        reason: facts,
      }
    : { type: "possible_same_event", basis: FUSION_RULE, reason: facts };
}

const latitude = "json_extract(view,'$.location.lat')";
/**
 * Index-bounded candidates for a record: earthquakes through incidents_cell, seeking the grid cells
 * within reach and, in each, window keys from the origin-time window on (a quake's key is at least
 * its origin time); cyclones by their exact storm name through the search index.
 */
export function fusionCandidates(view: IncidentView) {
  const s = signature(view);
  if (!s) return null;
  if (s.hazard === "tropical_cyclone")
    return {
      sql: "SELECT i.view FROM incidents_fts f JOIN incidents i ON i.id=f.incident_id WHERE incidents_fts MATCH ? AND i.deleted_at IS NULL AND json_extract(i.view,'$.activity')='tropical_cyclone' AND i.id<>? LIMIT 20",
      params: ['search_text : "' + s.name!.replaceAll("-", " ") + '"', view.id],
    };
  const band = QUAKE_REACH_KM / 111,
    window = QUAKE_POSSIBLE_SECONDS * 1000,
    // A reach of a few degrees never covers the whole grid, so there are always cells.
    cells = bboxCandidates([s.lon, s.lat, s.lon, s.lat], QUAKE_REACH_KM).cells!;
  return {
    sql: `SELECT view FROM incidents INDEXED BY incidents_cell WHERE deleted_at IS NULL AND ${locationCell} IN(${cells.join(",")}) AND ${windowKey}>=? AND ${latitude} BETWEEN ? AND ? AND json_extract(view,'$.activity')='earthquake' AND json_extract(view,'$.event_start') BETWEEN ? AND ? AND id<>? LIMIT 20`,
    params: [
      new Date(s.time - window).toISOString(),
      s.lat - band,
      s.lat + band,
      new Date(s.time - window).toISOString(),
      new Date(s.time + window).toISOString(),
      view.id,
    ],
  };
}

const ordered = (links: IncidentLink[]) =>
  [...links].sort((a, b) =>
    a.incident_id < b.incident_id ? -1 : a.incident_id > b.incident_id ? 1 : 0,
  );
const same = (a: IncidentLink[] = [], b: IncidentLink[] = []) =>
  JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

/**
 * Recomputes the rule links of `view` against `others`, which must hold its candidates and every
 * incident it linked before. Operator decisions on either side stand. Returns the links for
 * `view` and each other incident whose mirrored links changed.
 */
export function relink(
  view: IncidentView,
  previous: IncidentLink[],
  others: IncidentView[],
) {
  const links: IncidentLink[] = [],
    changed: IncidentView[] = [];
  for (const other of others) {
    if (other.id === view.id) continue;
    const decided =
      previous.find((l) => l.incident_id === other.id && l.basis === "operator") ??
      other.links?.find((l) => l.incident_id === view.id && l.basis === "operator");
    const verdict = decided ? null : sameEvent(view, other);
    const link = decided
      ? { ...decided, incident_id: other.id }
      : verdict && { incident_id: other.id, ...verdict };
    if (link) links.push(link);
    const mirrored = [
      ...(other.links ?? []).filter((l) => l.incident_id !== view.id),
      ...(link ? [{ ...link, incident_id: view.id }] : []),
    ];
    if (!same(mirrored, other.links)) changed.push(withLinks(other, mirrored));
  }
  return { links: ordered(links), changed };
}
/** The view with these links in a stable order, and no links field when there are none. */
export function withLinks(view: IncidentView, links: IncidentLink[]): IncidentView {
  const { links: _, ...rest } = view;
  return links.length ? { ...rest, links: ordered(links) } : rest;
}
