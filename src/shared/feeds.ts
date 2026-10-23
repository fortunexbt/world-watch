/** The public demo's static feeds: every area, hazard and impact combination below, each as Atom and GeoJSON. */
import type { IncidentView } from "./contracts";
import { inBbox } from "./view";

/** Areas as [west, south, east, north]; west above east crosses the antimeridian. The bbox is the path segment. */
export const FEED_AREAS = [
  { name: "World", bbox: [-180, -90, 180, 90] },
  { name: "North America", bbox: [-170, 15, -50, 84] },
  { name: "Central America and the Caribbean", bbox: [-118, 5, -58, 33] },
  { name: "South America", bbox: [-92, -56, -30, 13] },
  { name: "Europe", bbox: [-25, 34, 45, 72] },
  { name: "Africa", bbox: [-26, -36, 52, 38] },
  { name: "Middle East", bbox: [25, 12, 63, 42] },
  { name: "South Asia", bbox: [60, 5, 98, 38] },
  { name: "East Asia", bbox: [98, 18, 150, 54] },
  { name: "Southeast Asia", bbox: [92, -11, 141, 24] },
  { name: "Oceania and the Pacific", bbox: [110, -50, -130, 5] },
] as const;
/** "all", or one of the hazard and aviation advisory activities the public structured sources publish. */
export const FEED_ACTIVITIES = [
  "all",
  "earthquake",
  "tropical_cyclone",
  "flood",
  "wildfire",
  "volcanic_eruption",
  "drought",
  "severe_weather",
  "conflict_zone_advisory",
] as const;
/** The lowest issuer impact a feed carries. "any" includes impact unknown, which most earthquakes are. */
export const FEED_IMPACTS = {
  any: null,
  significant: ["significant", "severe", "critical"],
  severe: ["severe", "critical"],
} as const;
export const DEFAULT_FEED = {
  bbox: FEED_AREAS[0].bbox,
  activity: "all",
  impact: "significant",
} as const;
/** Newest entries kept per feed; readers keep what they have already seen. */
export const FEED_ENTRY_LIMIT = 100;

export type FeedFilter = {
  bbox: readonly number[];
  activity: (typeof FEED_ACTIVITIES)[number];
  impact: keyof typeof FEED_IMPACTS;
};
export type FeedFormat = "atom" | "geojson";

/** Relative to the snapshot's data directory, for example `feeds/-180,-90,180,90/all/significant.atom`. */
export const feedPath = (f: FeedFilter, format: FeedFormat) =>
  `feeds/${f.bbox.join(",")}/${f.activity}/${f.impact}.${format}`;

export function feedMatches(i: IncidentView, f: FeedFilter) {
  const impacts: readonly string[] | null = FEED_IMPACTS[f.impact];
  return (
    inBbox(i.location, [...f.bbox]) &&
    (f.activity === "all" || i.activity === f.activity) &&
    (!impacts || impacts.includes(i.impact))
  );
}

export const feedFilters = (): FeedFilter[] =>
  FEED_AREAS.flatMap(({ bbox }) =>
    FEED_ACTIVITIES.flatMap((activity) =>
      (Object.keys(FEED_IMPACTS) as FeedFilter["impact"][]).map((impact) => ({
        bbox,
        activity,
        impact,
      })),
    ),
  );
