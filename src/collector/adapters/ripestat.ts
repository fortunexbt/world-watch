import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import borders from "../../shared/borders.json";
import { mainland } from "../../shared/borders.js";
import { polygonArea } from "./area.js";

export const RIPESTAT_ROUTING_URL =
  "https://stat.ripe.net/data/country-resource-stats/data.json";
const HOUR = 3600000;
/** Countries the map can draw, polled in this order. RIPEstat answers one country per request. */
export const ROUTING_COUNTRIES = (borders as [string, unknown][])
  .map(([code]) => code)
  .sort();
/** Fourteen days of hourly samples: seven to track a drop, preceded by the seven its baseline needs. */
const WINDOW_HOURS = 14 * 24;
const TRACK_HOURS = 7 * 24;
const BASELINE_HOURS = 7 * 24;
const MIN_BASELINE_HOURS = 24;
/** Below this many visible IPv4 prefixes one network's routing change reads as a national drop. */
const MIN_PREFIXES = 50;
const CONFIRM_HOURS = 2;
/** RIPEstat lagged about two hours on 22 October 2026; older data says nothing about now. */
const STALE_HOURS = 6;
/** Impact from the largest share of the baseline's prefixes lost. A measured routing loss states no harm, so it never reaches critical. */
export const routingImpact = (drop: number) =>
  drop >= 0.9 ? "severe" : drop >= 0.5 ? "significant" : "minor";
const regions = new Intl.DisplayNames("en", { type: "region" });

/** The hourly request for one country, starting fourteen days before the hour. sourceapp identifies World Watch to RIPE NCC. */
export function routingURL(country: string, now: number) {
  const start = Math.floor(now / HOUR) * HOUR - WINDOW_HOURS * HOUR;
  return (
    RIPESTAT_ROUTING_URL +
    "?" +
    new URLSearchParams({
      resource: country.toLowerCase(),
      starttime: new Date(start).toISOString().slice(0, 16),
      resolution: "1h",
      sourceapp: "world-watch",
    })
  );
}

type Sample = { at: number; v4: number; asns: number };
type Baseline = { v4: number; asns: number; from: number; to: number };
type RoutingDrop = {
  baseline: Baseline;
  start: number;
  low_until: number;
  recovered_at: number | null;
  lowest_v4: number;
  lowest_asns: number;
};

/** RIPEstat folds identical consecutive hours into one row with several validity periods; this unfolds them into hourly samples. */
function samples(payload: unknown, country: string): Sample[] {
  const data = (payload as any)?.data;
  if (
    (payload as any)?.status !== "ok" ||
    data?.resource !== country.toLowerCase() ||
    data?.resolution !== "1h" ||
    !Array.isArray(data?.stats)
  )
    throw Error("invalid_ripestat_response");
  const hours = new Map<number, Sample>();
  for (const row of data.stats) {
    const v4 = row?.v4_prefixes_ris,
      asns = row?.asns_ris;
    if (!Number.isFinite(v4) || !Number.isFinite(asns) || v4 < 0 || asns < 0)
      continue;
    for (const period of Array.isArray(row.timeline) ? row.timeline : []) {
      const from = Date.parse(period?.starttime + "Z"),
        to = Date.parse(period?.endtime + "Z");
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
      for (let at = from; at <= to; at += HOUR) hours.set(at, { at, v4, asns });
    }
  }
  return [...hours.values()].sort((a, b) => a.at - b.at);
}

const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b),
    m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
/** A quarter of the prefixes gone with a tenth of the networks, or half the prefixes on their own: aggregating routes lowers prefix counts without losing networks. */
const low = (s: Sample, b: Baseline) =>
  s.v4 <= 0.5 * b.v4 || (s.v4 <= 0.75 * b.v4 && s.asns <= 0.9 * b.asns);

/**
 * Walks hourly samples against the median of the preceding seven days of normal hours. Low hours
 * never enter a baseline, so a long drop cannot become its own reference. A drop starts at the
 * first of two consecutive low hours and ends at the first of two consecutive recovered hours.
 * Missing hours are skipped, never counted as low.
 */
function routingDrops(series: Sample[]): RoutingDrop[] {
  const drops: RoutingDrop[] = [],
    normal: Sample[] = [];
  let pending: Sample[] = [],
    recovering: Sample[] = [],
    open: RoutingDrop | null = null;
  for (const s of series) {
    if (open) {
      if (low(s, open.baseline)) {
        recovering = [];
        open.low_until = s.at;
        open.lowest_v4 = Math.min(open.lowest_v4, s.v4);
        open.lowest_asns = Math.min(open.lowest_asns, s.asns);
      } else if (recovering.push(s) >= CONFIRM_HOURS) {
        drops.push({ ...open, recovered_at: recovering[0].at });
        open = null;
        recovering = [];
      }
      continue;
    }
    const recent = normal.slice(-BASELINE_HOURS);
    const baseline: Baseline | null =
      recent.length >= MIN_BASELINE_HOURS
        ? {
            v4: median(recent.map((x) => x.v4)),
            asns: median(recent.map((x) => x.asns)),
            from: recent[0].at,
            to: recent.at(-1)!.at,
          }
        : null;
    if (!baseline || baseline.v4 < MIN_PREFIXES || !low(s, baseline)) {
      pending = [];
      normal.push(s);
      continue;
    }
    if (pending.push(s) < CONFIRM_HOURS) continue;
    open = {
      baseline,
      start: pending[0].at,
      low_until: s.at,
      recovered_at: null,
      lowest_v4: Math.min(...pending.map((x) => x.v4)),
      lowest_asns: Math.min(...pending.map((x) => x.asns)),
    };
    pending = [];
  }
  return open ? [...drops, open] : drops;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * World Watch's own drop detection for one country from a RIPEstat country-resource-stats response.
 * Null when the response holds no sample from the last six hours: a lagging measurement can
 * neither start nor end a drop.
 */
export function parseRipestatRouting(
  source: SourceRecord,
  country: string,
  payload: unknown,
  now: number,
): ObservationInput[] | null {
  const series = samples(payload, country);
  const latest = series.at(-1)?.at;
  if (latest === undefined || latest < now - STALE_HOURS * HOUR) return null;
  const area = polygonArea({
    type: "Polygon",
    coordinates: mainland(country),
  });
  if (!area) throw Error("unmapped_routing_country");
  const name = regions.of(country) ?? country;
  return routingDrops(series)
    .filter((d) => d.start >= latest - TRACK_HOURS * HOUR)
    .map((d) => {
      const id = `${country}-${iso(d.start).slice(0, 13)}`;
      const drop = 1 - d.lowest_v4 / d.baseline.v4;
      const evidence = new URLSearchParams({
        resource: country.toLowerCase(),
        starttime: iso(d.baseline.from).slice(0, 16),
        ...(d.recovered_at === null
          ? {}
          : { endtime: iso(d.recovered_at + HOUR).slice(0, 16) }),
        resolution: "1h",
      });
      return {
        source_id: source.id,
        native_id: id,
        source_event_id: id,
        canonical_url: RIPESTAT_ROUTING_URL + "?" + evidence,
        title: `Internet routing visibility drop, ${name}`,
        original_language: "en",
        published_at: null,
        source_updated_at: iso(latest),
        input_coverage: "permitted_excerpt" as const,
        excerpts: [
          {
            id: "ripestat-routing",
            text: JSON.stringify({
              country: name,
              measurement:
                "IPv4 prefixes and origin networks (ASNs) registered to the country and visible in RIPE RIS routing data, hourly",
              baseline_from: iso(d.baseline.from),
              baseline_to: iso(d.baseline.to),
              baseline_ipv4_prefixes: d.baseline.v4,
              baseline_asns: d.baseline.asns,
              lowest_ipv4_prefixes: d.lowest_v4,
              lowest_asns: d.lowest_asns,
              largest_drop_percent: Math.round(100 * drop),
              drop_started: iso(d.start),
              low_until: iso(d.low_until),
              recovered_at:
                d.recovered_at === null ? null : iso(d.recovered_at),
              notice:
                "World Watch's own detection from RIPE NCC RIPEstat country routing statistics, built on RIPE RIS route collector data. A drop means fewer of the country's registered IPv4 prefixes and networks were visible in global routing than the median of the preceding seven days. It is not a confirmed shutdown and states no cause: a government order, a power cut, a cable cut, a large network's failure or a routing change can each produce it, and a shutdown that filters traffic without withdrawing routes does not show here. Prefixes count by RIR registration country, not where they are used. The circle covers the country's largest landmass to mark the whole country, not an affected area. World Watch keeps the drop live while hourly samples stay low and ends it at the first of two recovered hours.",
            }),
          },
        ],
        source_geo: { ...area, name, accuracy: "area" as const, country },
        official: {
          issuer: "World Watch detection from RIPE NCC RIPEstat (RIS)",
          effective_at: iso(d.start),
          expires_at: d.recovered_at === null ? null : iso(d.recovered_at),
          ...(d.recovered_at === null ? { current_listing: true } : {}),
          activity: "connectivity_disruption" as const,
          impact: routingImpact(drop),
        },
      };
    });
}
