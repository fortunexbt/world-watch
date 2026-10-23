import type { ObservationInput, SourceRecord } from "../../shared/contracts.js";
import { buildFootprint, type Position } from "../../shared/footprint.js";
import { decodeEntities, parseXML, plain } from "../parsers.js";
import { polygonArea } from "./area.js";

/**
 * Common Alerting Protocol 1.2 (OASIS), read from a parsed XML or JSON alert. Polygons and
 * circles are converted to GeoJSON order; geocodes are kept as the issuer's codes, never resolved
 * to a guessed geometry.
 */
export type CapArea = {
  description: string;
  polygons: Position[][];
  circles: { lon: number; lat: number; radius_km: number }[];
  geocodes: { name: string; value: string }[];
};
export type CapInfo = {
  /** RFC 3066 tag; CAP's default is en-US when the issuer states none. */
  language: string;
  categories: string[];
  event: string;
  urgency: string | null;
  severity: string | null;
  certainty: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  sender_name: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  web: string | null;
  parameters: { name: string; value: string }[];
  areas: CapArea[];
};
export type CapAlert = {
  identifier: string;
  sender: string;
  sent: string;
  status: string;
  msg_type: string;
  scope: string;
  /** Earlier messages this one updates or cancels, as CAP lists them. */
  references: { sender: string; identifier: string; sent: string | null }[];
  infos: CapInfo[];
};
/** CAP severity states a threat, not observed harm, so each level maps one step down and Extreme never becomes critical. */
export const CAP_IMPACT = {
  Minor: "informational",
  Moderate: "minor",
  Severe: "significant",
  Extreme: "severe",
} as const;
/** Ack and Error messages address other systems, not the public. */
const MESSAGE_TYPES = new Set(["Alert", "Update", "Cancel"]);
/** Sides of the polygon drawn around a CAP circle; its edges stay within 0.12% of the radius outside the circle. */
const CIRCLE_SIDES = 64;
/** A parameter value longer than this, such as a list of hundreds of municipalities, is named but not kept. */
const PARAMETER_LENGTH = 500;
type Activity = NonNullable<
  NonNullable<ObservationInput["official"]>["activity"]
>;
/**
 * The issuer's own event name decides the activity. A weather message that names no tropical
 * cyclone or flood is severe weather; rain does not state flooding and a fire danger rating is
 * not a fire. Anything else stays a generic official advisory, including tsunami messages, which
 * the activity list has no entry for.
 */
const ACTIVITIES: [RegExp, Activity][] = [
  [
    /\b(?:tropical (?:cyclone|storm|depression)|typhoon|hurricane(?![- ]force)|ciclone tropical|ciclon tropical|tormenta tropical|tufao)\b/,
    "tropical_cyclone",
  ],
  [
    /\b(?:flood\w*|flash flood|storm surge|inundac\w*|enchente\w*|alagamento\w*|hochwasser|uberschwemmung\w*|sturmflut)\b/,
    "flood",
  ],
  [/\b(?:earthquake|terremoto|sismo|erdbeben)\b/, "earthquake"],
];
const WILDFIRE =
  /\b(?:wildfire|bush ?fire|forest fire|grass ?fire|incendio florestal|incendio forestal|waldbrand)\b/;
const DANGER = /\b(?:danger|risk|gefahr|risco|riesgo|perigo|peligro)\b/;

const list = (x: unknown): any[] =>
  x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
/** Element text as the issuer wrote it, with character references resolved and line endings normalised. */
const text = (value: unknown): string =>
  typeof value === "string"
    ? decodeEntities(value).replace(/\r\n?/g, "\n").trim()
    : typeof value === "object" && value !== null && "#text" in value
      ? text((value as Record<string, unknown>)["#text"])
      : "";
const optional = (value: unknown) => text(value) || null;
/** CAP times carry an explicit offset; anything else is unknown rather than guessed as UTC. */
export const capTime = (value: unknown): string | null => {
  const v = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    v,
  ) && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null;
};
const pairs = (value: unknown) =>
  list(value).flatMap((p) => {
    const name = text(p?.valueName),
      v = text(p?.value);
    return name && v ? [{ name, value: v }] : [];
  });
const coordinate = (pair: string): Position | null => {
  const parts = pair.split(",");
  const [lat, lon] = parts.map(Number);
  return parts.length === 2 &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
    ? [lon, lat]
    : null;
};
/** "lat,lon lat,lon ..." with the first pair repeated last, as CAP writes a polygon. */
function polygon(value: unknown): Position[] | null {
  const points = text(value).split(/\s+/).filter(Boolean).map(coordinate);
  if (points.length < 4 || points.some((p) => !p)) return null;
  const ring = points as Position[];
  const [a, b] = [ring[0], ring.at(-1)!];
  return a[0] === b[0] && a[1] === b[1] ? ring : null;
}
/** "lat,lon radius" with the radius in kilometres. */
function circle(value: unknown) {
  const [centre, radius, ...rest] = text(value).split(/\s+/);
  const point = centre ? coordinate(centre) : null,
    radius_km = Number(radius);
  return point && !rest.length && Number.isFinite(radius_km) && radius_km > 0
    ? { lon: point[0], lat: point[1], radius_km }
    : null;
}

/** The fields of one CAP alert, or null without the identifier and sent time CAP requires. */
export function capAlert(value: any): CapAlert | null {
  const identifier = text(value?.identifier),
    sent = capTime(value?.sent);
  if (!identifier || !sent) return null;
  return {
    identifier,
    sender: text(value.sender),
    sent,
    status: text(value.status),
    msg_type: text(value.msgType),
    scope: text(value.scope),
    references: text(value.references)
      .split(/\s+/)
      .flatMap((r) => {
        const [sender, identifier, sent] = r.split(",");
        return sender && identifier
          ? [{ sender, identifier, sent: capTime(sent) }]
          : [];
      }),
    infos: list(value.info).map((info) => ({
      language: text(info?.language) || "en-US",
      categories: list(info?.category).map(text).filter(Boolean),
      event: text(info?.event),
      urgency: optional(info?.urgency),
      severity: optional(info?.severity),
      certainty: optional(info?.certainty),
      effective: capTime(info?.effective),
      onset: capTime(info?.onset),
      expires: capTime(info?.expires),
      sender_name: optional(info?.senderName),
      headline: optional(info?.headline),
      description: optional(info?.description),
      instruction: optional(info?.instruction),
      web: optional(info?.web),
      parameters: pairs(info?.parameter),
      areas: list(info?.area).map((area) => ({
        description: text(area?.areaDesc),
        polygons: list(area?.polygon)
          .map(polygon)
          .filter((p): p is Position[] => !!p),
        circles: list(area?.circle)
          .map(circle)
          .filter((c): c is NonNullable<ReturnType<typeof circle>> => !!c),
        geocodes: pairs(area?.geocode),
      })),
    })),
  };
}
/** A CAP 1.2 XML document, with or without a namespace prefix. */
export function readCap(xml: string): CapAlert {
  const alert = capAlert(parseXML(xml, true).alert);
  if (!alert) throw Error("invalid_cap_alert");
  return alert;
}

const primary = (tag: string) => tag.split("-")[0].toLowerCase();
/**
 * The info blocks in the issuer's language, or in the first block's language when none matches.
 * CAP lets later blocks in one language add areas but not override earlier values, so callers
 * read fields from the first and areas from all of them.
 */
export function capInfos(alert: CapAlert, language: string): CapInfo[] {
  const wanted = alert.infos.some(
    (i) => primary(i.language) === primary(language),
  )
    ? primary(language)
    : primary(alert.infos[0]?.language ?? "");
  return alert.infos.filter((i) => primary(i.language) === wanted);
}
/**
 * A circle as a closed ring whose edges touch it from outside, so the area drawn and matched never
 * falls short of the issuer's circle.
 */
export function circleRing(c: CapArea["circles"][number]): Position[] {
  const reach = c.radius_km / Math.cos(Math.PI / CIRCLE_SIDES) / 6371.0088,
    lat = (c.lat * Math.PI) / 180,
    lon = (c.lon * Math.PI) / 180;
  const ring = Array.from({ length: CIRCLE_SIDES }, (_, i): Position => {
    const bearing = (2 * Math.PI * i) / CIRCLE_SIDES,
      y = Math.asin(
        Math.sin(lat) * Math.cos(reach) +
          Math.cos(lat) * Math.sin(reach) * Math.cos(bearing),
      ),
      x =
        lon +
        Math.atan2(
          Math.sin(bearing) * Math.sin(reach) * Math.cos(lat),
          Math.cos(reach) - Math.sin(lat) * Math.sin(y),
        );
    return [(((x * 180) / Math.PI + 540) % 360) - 180, (y * 180) / Math.PI];
  });
  return [...ring, ring[0]];
}
function activity(info: CapInfo): Activity | undefined {
  const event = info.event
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const named = ACTIVITIES.find(([pattern]) => pattern.test(event))?.[1];
  if (named === "earthquake")
    return info.categories.includes("Geo") ? named : undefined;
  if (named) return named;
  if (WILDFIRE.test(event) && !DANGER.test(event)) return "wildfire";
  return info.categories.includes("Met") ? "severe_weather" : undefined;
}

/**
 * One issuer CAP message as an observation, or none for test, exercise, system, restricted and
 * acknowledgement messages. The message identifier is the native ID; an update or cancellation
 * names the earliest message it references as its event, so a chain stays one incident even when
 * its first message was never read. Text stays in the issuer's language, with its English block
 * beside it when the issuer publishes one.
 */
export function parseCap(
  source: SourceRecord,
  alert: CapAlert,
  url: string,
): ObservationInput[] {
  if (
    alert.status !== "Actual" ||
    alert.scope !== "Public" ||
    !MESSAGE_TYPES.has(alert.msg_type)
  )
    return [];
  const infos = capInfos(alert, source.languages[0] ?? "en");
  const info = infos[0];
  if (!info) return [];
  const english =
    primary(info.language) === "en"
      ? undefined
      : alert.infos.find((i) => primary(i.language) === "en");
  const areas = infos.flatMap((i) => i.areas);
  const parts = areas.flatMap((a) =>
    [...a.polygons, ...a.circles.map(circleRing)].map((ring) => ({
      geometry: { type: "Polygon", coordinates: [ring] },
      label: a.description,
    })),
  );
  const area = polygonArea({
    type: "MultiPolygon",
    coordinates: parts.map((p) => p.geometry.coordinates),
  });
  const footprint = area && buildFootprint("advisory_area", url, parts);
  const severity =
    info.severity && Object.hasOwn(CAP_IMPACT, info.severity)
      ? (info.severity as keyof typeof CAP_IMPACT)
      : null;
  const first = [...alert.references].sort((a, b) =>
    (a.sent ?? "9").localeCompare(b.sent ?? "9"),
  )[0];
  const names = areas.map((a) => a.description).filter(Boolean);
  const issuer = info.sender_name || String(source.config.issuer_label);
  return [
    {
      source_id: source.id,
      native_id: alert.identifier,
      source_event_id: first?.identifier ?? alert.identifier,
      canonical_url: url,
      title: plain(info.headline || info.event || issuer),
      original_language: info.language,
      published_at: alert.sent,
      source_updated_at: alert.sent,
      input_coverage: "full_licensed_text" as const,
      excerpts: [
        {
          id: "cap-alert",
          text: JSON.stringify({
            cap_identifier: alert.identifier,
            issuer: source.config.issuer_label,
            sender: alert.sender || null,
            sender_name: info.sender_name,
            message_type: alert.msg_type,
            references: alert.references.map((r) => r.identifier),
            language: info.language,
            event: info.event || null,
            categories: info.categories,
            severity: info.severity,
            urgency: info.urgency,
            certainty: info.certainty,
            sent: alert.sent,
            effective: info.effective,
            onset: info.onset,
            expires: info.expires,
            headline: info.headline,
            description: info.description,
            instruction: info.instruction,
            web: info.web,
            areas: names,
            unmapped_areas: areas
              .filter((a) => !a.polygons.length && !a.circles.length)
              .map((a) => a.description),
            geocodes: areas.flatMap((a) =>
              a.geocodes.map((g) => `${g.name} ${g.value}`),
            ),
            parameters: info.parameters
              .filter((p) => p.value.length <= PARAMETER_LENGTH)
              .map((p) => `${p.name}: ${p.value}`),
            parameters_not_kept: info.parameters
              .filter((p) => p.value.length > PARAMETER_LENGTH)
              .map((p) => p.name),
            event_en: english?.event || null,
            headline_en: english?.headline ?? null,
            description_en: english?.description ?? null,
            instruction_en: english?.instruction ?? null,
            notice:
              "Official warning reproduced unchanged in the issuer's language, with the issuer's English text where it publishes one. The point is the centre of the warned areas and the radius reaches their farthest vertex, so the circle is wider than the warned area; a CAP circle is drawn as a 64-sided polygon enclosing it. Areas the issuer names only by code are listed but not mapped. Severity is the issuer's statement of threat, not observed harm.",
          }),
        },
      ],
      ...(area
        ? {
            source_geo: {
              ...area,
              name: names.join("; ") || info.event,
              accuracy: "area" as const,
            },
          }
        : {}),
      ...(footprint ? { footprint } : {}),
      official: {
        issuer,
        effective_at: info.onset ?? info.effective ?? alert.sent,
        expires_at: info.expires,
        activity: activity(info) ?? "official_advisory",
        impact: severity ? CAP_IMPACT[severity] : ("unknown" as const),
        cancelled: alert.msg_type === "Cancel",
        message_type: alert.msg_type,
        references: alert.references.map((r) => r.identifier),
      },
    },
  ];
}

/**
 * The CAP documents an issuer's Atom or RSS index lists, in its order. Only the path of each link
 * is used, on the index's own origin, and it must match the issuer's document pattern: one
 * issuer's index links some documents through a bare IP address whose certificate names its host.
 */
export function capIndex(source: SourceRecord, xml: string) {
  const doc = parseXML(xml);
  const pattern = new RegExp(String(source.config.document_path));
  const entries = doc.feed
    ? list(doc.feed.entry).map((e: any) => ({
        link: list(e.link).find(
          (l: any) => l?.["@_type"] === "application/cap+xml",
        )?.["@_href"],
        stamp: text(e.updated),
      }))
    : doc.rss
      ? list(doc.rss.channel?.item).map((i: any) => ({
          link: text(i.link) || text(i.guid),
          stamp: text(i.pubDate),
        }))
      : null;
  if (!entries) throw Error("unsupported_cap_index");
  const origin = new URL(source.url).origin;
  return [
    ...new Map(
      entries.map(({ link, stamp }) => {
        let path: string;
        try {
          path = new URL(text(link)).pathname;
        } catch {
          throw Error("invalid_cap_index_link");
        }
        if (!pattern.test(path)) throw Error("unexpected_cap_document_path");
        const url = origin + path;
        return [url, { url, stamp }];
      }),
    ).values(),
  ];
}

/** BBK's CAP warnings, published as JSON, with the area polygon from BBK's separate GeoJSON. */
export function parseBbk(
  source: SourceRecord,
  json: string,
  geo?: any,
): ObservationInput[] {
  const x = JSON.parse(json);
  if (x.status !== "Actual" || x.scope !== "Public") return [];
  const alert = capAlert(x);
  const info = alert && capInfos(alert, "de")[0];
  if (!alert || !info) throw Error("invalid_bbk_warning");
  const area = polygonArea(geo?.features?.[0]?.geometry);
  return [
    {
      source_id: source.id,
      native_id: alert.identifier,
      canonical_url:
        "https://warnung.bund.de/meldung/" +
        encodeURIComponent(alert.identifier),
      title: plain(info.headline),
      original_language: info.language,
      published_at: alert.sent,
      source_updated_at: alert.sent,
      input_coverage: "full_licensed_text",
      excerpts: [
        { id: "warning", text: plain(info.description) },
        { id: "instruction", text: plain(info.instruction) },
      ],
      ...(area
        ? {
            source_geo: {
              ...area,
              name: info.areas.map((a) => a.description).join("; "),
              accuracy: "area" as const,
            },
          }
        : {}),
      official: {
        issuer: source.owner,
        effective_at: info.effective ?? info.onset ?? alert.sent,
        expires_at: info.expires,
        cancelled: alert.msg_type === "Cancel",
        message_type: alert.msg_type,
        references: alert.references.map((r) => r.identifier),
      },
      priority: 20,
    },
  ];
}
