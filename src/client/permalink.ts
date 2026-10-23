// The view state a link carries. Every parameter is optional, so links made before a parameter
// existed open as they did, and parameters this file does not know are left in place.
import { GIBS_LAYERS, type GibsLayerId } from "./imagery";

/** Map layers a link can switch on; `layer=cameras` is how older links named the camera layer. */
export const LINK_LAYERS = ["thermal", "emergency_mapping", "cameras", "density", "gnss"] as const;
export type LinkLayer = (typeof LINK_LAYERS)[number];
export type LinkedView = {
  q: string;
  hours: string;
  filter: string;
  source: string;
  language: string;
  evidence: string;
  incident: string | null;
  camera: string | null;
  /** The replay time as an ISO instant, or null for live. */
  at: string | null;
  /** "World", "Map area" or "watch:<id>"; a private area's bounds never enter the link. */
  scope: string;
  /** The map camera as zoom/latitude/longitude. */
  map: { zoom: number; lat: number; lon: number } | null;
  layers: LinkLayer[];
  imagery: { layer: GibsLayerId; day: string | null } | null;
};

export function readView(search: string): LinkedView {
  const p = new URLSearchParams(search),
    at = p.get("at"),
    scope = p.get("scope") ?? "",
    camera = (p.get("map") ?? "").split("/").map(Number),
    imagery = p.get("imagery") as GibsLayerId | null,
    day = p.get("imagery_day");
  return {
    q: p.get("q") ?? "",
    hours: p.get("hours") || "168",
    filter: p.get("filter") || "all",
    source: p.get("source") ?? "",
    language: p.get("language") ?? "",
    evidence: p.get("evidence") ?? "",
    incident: p.get("incident"),
    camera: p.get("camera"),
    at: at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null,
    scope: scope === "map" ? "Map area" : /^watch:./.test(scope) ? scope : "World",
    map:
      camera.length === 3 && camera.every(Number.isFinite) && Math.abs(camera[1]) <= 90
        ? { zoom: camera[0], lat: camera[1], lon: camera[2] }
        : null,
    layers: (p.get("layer") ?? "").split(",").filter((l): l is LinkLayer => (LINK_LAYERS as readonly string[]).includes(l)),
    imagery:
      imagery && imagery in GIBS_LAYERS
        ? { layer: imagery, day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null }
        : null,
  };
}

/** `url` with the view's parameters set, defaults and empty values removed. */
export function writeView(url: URL, view: LinkedView) {
  const p = url.searchParams;
  const values: Record<string, string | null> = {
    q: view.q,
    hours: view.hours,
    filter: view.filter === "all" ? "" : view.filter,
    source: view.source,
    language: view.language,
    evidence: view.evidence,
    incident: view.incident,
    camera: view.camera,
    at: view.at,
    scope: view.scope === "Map area" ? "map" : view.scope.startsWith("watch:") ? view.scope : "",
    map: view.map
      ? `${+view.map.zoom.toFixed(2)}/${+view.map.lat.toFixed(4)}/${+view.map.lon.toFixed(4)}`
      : "",
    layer: view.layers.join(","),
    imagery: view.imagery?.layer ?? "",
    imagery_day: view.imagery?.day ?? "",
  };
  for (const [key, value] of Object.entries(values))
    if (value) p.set(key, value);
    else p.delete(key);
  return url;
}
