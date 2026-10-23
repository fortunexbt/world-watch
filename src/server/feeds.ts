// Atom 1.0 (RFC 4287) and GeoJSON (RFC 7946) renderings of alert notices and public snapshot
// records. One entry per incident or fused situation: its ID never changes and `updated` moves
// only when it changes materially, so feed readers show a correction as an update of the entry.
import type { IncidentView } from "../shared/contracts";
import type { Situation } from "../shared/fusion";
import { CORRECTION } from "./alerts";

export type FeedEntry = {
  /** The incident ID the entry is keyed to, which stays put when a situation's lead changes. */
  id: string;
  incident: Situation;
  /** When this notice last changed materially. */
  updated: string;
  /** Why this entry corrects what it said earlier, or null when it doesn't. */
  correction: string | null;
};
export type FeedMeta = {
  id: string;
  title: string;
  subtitle: string;
  /** Absolute or relative to the feed document. */
  self: string;
  alternate: string;
  /** Attribution of every source that can appear in the feed. */
  attribution: string[];
  /** Used when the feed has no entries. */
  updated: string;
};

export const entryId = (incidentId: string) =>
  `urn:world-watch:incident:${incidentId}`;

/** Only records whose every source permits redistribution leave the app as a feed. */
export const redistributable = (i: IncidentView) =>
  i.reports.length > 0 &&
  i.reports.every(
    (r: any) =>
      r.rights?.access &&
      r.rights.storage &&
      r.rights.display &&
      r.rights.redistribute,
  );

/** The correction an incident's own state announces, for records with no alert decision behind them. */
export function incidentCorrection(i: IncidentView) {
  if (i.cancelled) return "withdrawn or cancelled by its issuer";
  if (i.evidence_status === "retracted") return "retracted by its source";
  if (i.evidence_status === "corrected") return "corrected since first published";
  return null;
}

/** The correction an alert notice carries: the cause its decision gave, else what the record's own state says. */
export function noticeCorrection(reason: string, i: IncidentView) {
  const cause = reason.startsWith(CORRECTION)
    ? reason.match(/\((.*)\)$/)?.[1]
    : undefined;
  return (
    cause
      ?.replace("current eligibility changed: ", "no longer meets this rule, ")
      .replaceAll("_", " ") ?? incidentCorrection(i)
  );
}

export const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").trim().replace(/\s+/g, " ");
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
};
const xml = (text: string) =>
  text
    // Characters XML 1.0 can't carry at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const attributions = (i: IncidentView) =>
  unique(i.reports.map((r: any) => r.rights?.attribution ?? ""));
const title = (e: FeedEntry) =>
  (e.correction ? "Correction: " : "") + clip(e.incident.headline, 300);

// The record's own summary stays out: for structured records it holds the raw issuer fields, and the entry links to the source.
function summary(e: FeedEntry) {
  const i = e.incident;
  const when = [
    i.event_start && `Starts ${i.event_start}.`,
    i.event_end && `Ends ${i.event_end}.`,
    i.expires_at && `Expires ${i.expires_at}.`,
  ];
  return [
    e.correction && `Correction to an earlier notice: ${e.correction}.`,
    `Impact ${i.impact.replaceAll("_", " ")}, ${i.activity.replaceAll("_", " ")}.`,
    i.location &&
      `${i.location.name} (${i.location.accuracy}${i.location.radius_km ? `, within ${Math.round(i.location.radius_km)} km` : ""}).`,
    ...when,
    `Evidence: ${i.evidence_status.replaceAll("_", " ")}.`,
    `Source: ${attributions(i).join(" | ")}`,
  ]
    .filter(Boolean)
    .join(" ");
}

const newest = (entries: FeedEntry[]) =>
  [...entries].sort(
    (a, b) =>
      b.updated.localeCompare(a.updated) ||
      a.id.localeCompare(b.id),
  );

export function atomFeed(meta: FeedMeta, entries: FeedEntry[]) {
  const sorted = newest(entries);
  const body = sorted.map((e) => {
    const i = e.incident;
    const [first, ...others] = unique(
      i.reports.map((r: any) => r.canonical_url ?? ""),
    );
    return [
      "<entry>",
      `<id>${xml(entryId(e.id))}</id>`,
      `<title type="text">${xml(title(e))}</title>`,
      `<updated>${xml(e.updated)}</updated>`,
      first && `<link rel="alternate" href="${xml(first)}"/>`,
      ...others.map((url) => `<link rel="related" href="${xml(url)}"/>`),
      `<category scheme="urn:world-watch:activity" term="${xml(i.activity)}"/>`,
      `<category scheme="urn:world-watch:impact" term="${xml(i.impact)}"/>`,
      e.correction &&
        `<category scheme="urn:world-watch:notice" term="correction"/>`,
      `<summary type="text">${xml(summary(e))}</summary>`,
      `<rights type="text">${xml(attributions(i).join(" | "))}</rights>`,
      i.location &&
        `<georss:point>${i.location.lat} ${i.location.lon}</georss:point>`,
      "</entry>",
    ]
      .filter(Boolean)
      .join("");
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">',
    `<id>${xml(meta.id)}</id>`,
    `<title type="text">${xml(meta.title)}</title>`,
    `<subtitle type="text">${xml(meta.subtitle)}</subtitle>`,
    `<updated>${xml(sorted[0]?.updated ?? meta.updated)}</updated>`,
    `<link rel="self" type="application/atom+xml" href="${xml(meta.self)}"/>`,
    `<link rel="alternate" type="application/geo+json" href="${xml(meta.alternate)}"/>`,
    "<author><name>World Watch</name></author>",
    `<rights type="text">${xml(meta.attribution.join(" | "))}</rights>`,
    ...body,
    "</feed>",
  ].join("\n");
}

export const geojsonFeature = (e: FeedEntry) => {
  const i = e.incident;
  return {
    type: "Feature" as const,
    id: e.id,
    geometry: i.location
      ? { type: "Point" as const, coordinates: [i.location.lon, i.location.lat] }
      : null,
    properties: {
      entry_id: entryId(e.id),
      incident_ids: (i.members ?? [i]).map((m) => m.id),
      headline: clip(i.headline, 300),
      impact: i.impact,
      activity: i.activity,
      evidence_status: i.evidence_status,
      correction: e.correction,
      updated: e.updated,
      event_start: i.event_start,
      event_end: i.event_end,
      expires_at: i.expires_at,
      place: i.location?.name ?? null,
      accuracy: i.location?.accuracy ?? null,
      radius_km: i.location?.radius_km ?? null,
      urls: unique(i.reports.map((r: any) => r.canonical_url ?? "")),
      attribution: i.reports.map((r: any) => ({
        source: r.source_name ?? r.source_id,
        attribution: r.rights?.attribution,
        license: r.rights?.basis,
      })),
    },
  };
};

export function geojsonFeed(meta: FeedMeta, entries: FeedEntry[]) {
  const sorted = newest(entries);
  return {
    type: "FeatureCollection" as const,
    id: meta.id,
    title: meta.title,
    description: meta.subtitle,
    updated: sorted[0]?.updated ?? meta.updated,
    attribution: meta.attribution,
    features: sorted.map(geojsonFeature),
  };
}
