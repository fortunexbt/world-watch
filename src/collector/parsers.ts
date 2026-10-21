import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { ObservationInput, SourceRecord } from "../shared/contracts.js";
const list = (x: any): any[] =>
  x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
const text = (x: any): string =>
  Array.isArray(x)
    ? x.map(text).join(" ")
    : typeof x === "object" && x !== null
      ? Object.entries(x)
          .filter(([k]) => !k.startsWith("@_"))
          .map(([, v]) => text(v))
          .join(" ")
      : String(x ?? "");
export function plain(x: any) {
  return text(x)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
const date = (x: any) => {
  const v = text(x);
  return v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
};
function safeLink(x: string, fallback: string) {
  try {
    const u = new URL(x);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : fallback;
  } catch {
    return fallback;
  }
}
export function parseXML(xml: string) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw Error("unsafe_xml_declaration");
  if (XMLValidator.validate(xml) !== true) throw Error("invalid_xml");
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    removeNSPrefix: false,
    parseTagValue: false,
    trimValues: true,
  }).parse(xml);
}
/** Narrow DPC template extractor: whole article text, never page chrome or footer headquarters. */
export function parseDpcArticle(html: string) {
  const articles = [
    ...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi),
  ];
  if (articles.length !== 1) throw Error("ambiguous_dpc_article");
  const article = articles[0][1].split(
    /<section\b[^>]*class="attachments-and-links"/i,
  )[0];
  const body = plain(article.replace(/<!--[\s\S]*?-->/g, ""));
  if (body.length < 80 || !/<p\b/i.test(article))
    throw Error("empty_dpc_article");
  return body;
}
export function parseFeed(
  source: SourceRecord,
  xml: string,
): ObservationInput[] {
  const doc = parseXML(xml);
  const atom = doc.feed;
  const items = list(
    atom?.entry ?? doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item,
  );
  if (!atom && !doc.rss && !doc["rdf:RDF"])
    throw Error("unsupported_feed_schema");
  const observations = items.flatMap((item: any) => {
    const title = plain(item.title);
    if (!title) return [];
    const links = list(item.link);
    const link = atom
      ? text(
          links.find((x) => x["@_rel"] === "alternate" || !x["@_rel"])?.[
            "@_href"
          ],
        )
      : text(item.link);
    const canonical = safeLink(link, source.url);
    const id = text(item.guid ?? item.id) || canonical;
    const body = plain(
      item.description ??
        item.summary ??
        item.content ??
        item["content:encoded"],
    );
    const excerpts = [
      { id: "title", text: title },
      ...(body ? [{ id: "body", text: body }] : []),
    ];
    const cap = !!item["cap:event"];
    if (cap)
      for (const key of [
        "areaDesc",
        "event",
        "onset",
        "expires",
        "effective",
        "severity",
        "instruction",
      ])
        if (item["cap:" + key])
          excerpts.push({
            id: "cap_" + key,
            text: key + ": " + plain(item["cap:" + key]),
          });
    const obs: ObservationInput = {
      source_id: source.id,
      native_id: id,
      canonical_url: canonical,
      title,
      original_language:
        text(
          item["@_xml:lang"] ??
            atom?.["@_xml:lang"] ??
            doc.rss?.channel?.language,
        ) ||
        source.languages[0] ||
        "und",
      published_at: date(item.pubDate ?? item.published ?? item["dc:date"]),
      source_updated_at: date(item.updated ?? item["cap:sent"]),
      input_coverage: body ? "permitted_excerpt" : "title_only",
      excerpts,
    };
    if (source.id === "no-politiloggen") {
      const u = new URL(canonical);
      const episode =
        u.protocol === "https:" && u.hostname === "www.politiet.no"
          ? u.pathname.match(
              /^\/politiloggen\/hendelse\/([a-zA-Z0-9-]+)\/\d+\/?$/,
            )?.[1]
          : undefined;
      if (episode) obs.source_event_id = "politiloggen:" + episode;
    }
    if (cap)
      obs.official = {
        issuer: source.owner,
        effective_at: date(item["cap:onset"] ?? item["cap:effective"]),
        expires_at: date(item["cap:expires"]),
        cancelled: /cancel/i.test(text(item["cap:message_type"])),
      };
    return [obs];
  });
  return source.id === "no-politiloggen"
    ? coalesceNorwayEpisodes(observations)
    : observations;
}
export function parseTfl(
  source: SourceRecord,
  json: string,
): ObservationInput[] {
  const items = JSON.parse(json);
  if (!Array.isArray(items)) throw Error("invalid_tfl_schema");
  return items.map((x: any) => {
    if (typeof x.id !== "string" || typeof x.comments !== "string")
      throw Error("invalid_tfl_record");
    const title = plain(x.location || x.comments);
    const coords =
      x.geography?.type === "Point" ? x.geography.coordinates : undefined;
    return {
      source_id: source.id,
      native_id: x.id,
      canonical_url: "https://tfl.gov.uk/traffic/status/",
      title,
      original_language: "en",
      published_at: null,
      source_updated_at: date(x.lastModifiedTime ?? x.currentUpdateDateTime),
      input_coverage: "full_licensed_text" as const,
      excerpts: [
        { id: "notice", text: plain(x.comments) },
        { id: "update", text: plain(x.currentUpdate) },
        {
          id: "conditions",
          text: `Category: ${x.category}; issuer impact: ${x.severity}; event start: ${x.startDateTime ?? "unknown"}; event end: ${x.endDateTime ?? "unknown"}`,
        },
      ],
      ...(Array.isArray(coords) &&
      coords.length === 2 &&
      coords.every(Number.isFinite)
        ? {
            source_geo: {
              lon: coords[0],
              lat: coords[1],
              name: title,
              accuracy: "point" as const,
            },
          }
        : {}),
      official: {
        issuer: "Transport for London",
        effective_at: date(x.startDateTime),
        expires_at: date(x.endDateTime),
      },
      priority: /protest|demonstrat|emergency|collision/i.test(x.comments)
        ? 10
        : 2,
    };
  });
}
export function parseBbk(
  source: SourceRecord,
  json: string,
  geo?: any,
): ObservationInput[] {
  const x = JSON.parse(json);
  if (x.status !== "Actual" || x.scope !== "Public") return [];
  const info = list(x.info).find((i) => i.language === "de") ?? list(x.info)[0];
  if (!info || !x.identifier) throw Error("invalid_bbk_warning");
  const coords = geo?.features?.[0]?.geometry?.coordinates;
  const ring =
    geo?.features?.[0]?.geometry?.type === "Polygon" ? coords?.[0] : undefined;
  let source_geo: ObservationInput["source_geo"];
  if (ring?.length) {
    const xs = ring.map((p: number[]) => p[0]),
      ys = ring.map((p: number[]) => p[1]);
    const lon = (Math.min(...xs) + Math.max(...xs)) / 2,
      lat = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = Math.max(
      ...ring.map(
        (p: number[]) =>
          111.32 *
          Math.hypot(
            (p[0] - lon) * Math.cos((lat * Math.PI) / 180),
            p[1] - lat,
          ),
      ),
    );
    source_geo = {
      lon,
      lat,
      name: list(info.area)
        .map((a) => a.areaDesc)
        .join("; "),
      accuracy: "area",
      radius_km: radius,
    };
  }
  return [
    {
      source_id: source.id,
      native_id: x.identifier,
      canonical_url:
        "https://warnung.bund.de/meldung/" + encodeURIComponent(x.identifier),
      title: plain(info.headline),
      original_language: info.language ?? "de",
      published_at: date(x.sent),
      source_updated_at: date(x.sent),
      input_coverage: "full_licensed_text",
      excerpts: [
        { id: "warning", text: plain(info.description) },
        { id: "instruction", text: plain(info.instruction) },
      ],
      ...(source_geo ? { source_geo } : {}),
      official: {
        issuer: source.owner,
        effective_at: date(info.effective ?? info.onset ?? x.sent),
        expires_at: date(info.expires),
        cancelled: x.msgType === "Cancel",
        message_type: x.msgType,
        references: text(x.references)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((r) => r.split(",")[1])
          .filter(Boolean),
      },
      priority: 20,
    },
  ];
}
export function parseDwd(
  source: SourceRecord,
  body: string,
): ObservationInput[] {
  const match = /^\s*warnWetter\.loadWarnings\(([\s\S]*)\);?\s*$/.exec(body);
  if (!match) throw Error("invalid_dwd_envelope");
  const root = JSON.parse(match[1]);
  return Object.entries(root.warnings ?? {}).flatMap(([region, items]) =>
    list(items).map((x) => ({
      source_id: source.id,
      native_id: `${region}:${x.event}:${x.start}`,
      canonical_url:
        "https://www.dwd.de/DE/wetter/warnungen_gemeinden/warnWetter_node.html",
      title: plain(x.headline),
      original_language: "de",
      published_at: null,
      source_updated_at: null,
      input_coverage: "full_licensed_text" as const,
      excerpts: [
        { id: "notice", text: plain(x.description) },
        { id: "instruction", text: plain(x.instruction) },
        {
          id: "area",
          text: `Area: ${x.regionName}; state: ${x.state}; onset: ${new Date(x.start).toISOString()}; expires: ${new Date(x.end).toISOString()}`,
        },
      ],
      official: {
        issuer: "Deutscher Wetterdienst",
        effective_at: new Date(x.start).toISOString(),
        expires_at: new Date(x.end).toISOString(),
      },
      priority: 3,
    })),
  );
}
export function parseSiri(
  source: SourceRecord,
  xml: string,
): ObservationInput[] {
  const doc = parseXML(xml);
  const situations = list(
    doc.Siri?.ServiceDelivery?.SituationExchangeDelivery?.Situations
      ?.PtSituationElement,
  );
  return situations
    .map((x: any) => ({
      source_id: source.id,
      native_id: text(x.SituationNumber),
      source_event_id:
        "siri:" + text(x.ParticipantRef) + ":" + text(x.SituationNumber),
      canonical_url:
        "https://www.sncf-voyageurs.com/fr/voyagez-avec-nous/en-france/",
      title: plain(
        list(x.Summary).find(
          (v) => String(v["@_xml:lang"]).toLowerCase() === "fr",
        ) ?? list(x.Summary)[0],
      ),
      original_language: "fr",
      published_at: date(x.CreationTime),
      source_updated_at: date(x.Version?.length === 16 ? null : x.Version),
      input_coverage: "full_licensed_text" as const,
      excerpts: [
        {
          id: "summary",
          text: plain(
            list(x.Summary).find(
              (v) => String(v["@_xml:lang"]).toLowerCase() === "fr",
            ) ?? list(x.Summary)[0],
          ),
        },
        {
          id: "description",
          text: plain(
            list(x.Description).find(
              (v) => String(v["@_xml:lang"]).toLowerCase() === "fr",
            ) ?? list(x.Description)[0],
          ),
        },
        ...(x.Affects || x.Consequences
          ? [
              {
                id: "affects",
                text: JSON.stringify(x.Affects ?? x.Consequences),
              },
            ]
          : []),
        {
          id: "validity",
          text: `Start: ${text(x.ValidityPeriod?.StartTime)}; End: ${text(x.ValidityPeriod?.EndTime)}; Progress: ${text(x.Progress)}`,
        },
      ],
      official: {
        issuer: "SNCF Voyageurs",
        effective_at: date(x.ValidityPeriod?.StartTime),
        expires_at: date(x.ValidityPeriod?.EndTime),
        cancelled: /closed|closing/i.test(text(x.Progress)),
      },
      priority: 3,
    }))
    .filter((x: ObservationInput) => x.native_id && x.title);
}

/** MIT item pubDate is strike start midnight, not publication. Keep the full licensed calendar record and its actual date precision. */
export function parseMitStrikes(
  source: SourceRecord,
  xml: string,
): ObservationInput[] {
  const doc = parseXML(xml);
  const channel = doc.rss?.channel;
  if (!channel) throw Error("invalid_mit_rss");
  return list(channel.item).flatMap((item) => {
    const title = plain(item.title),
      body = plain(item.description),
      native = text(item.guid);
    if (!title || !native) return [];
    const start = title.match(/Data inizio:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
    const iso = start ? `${start[3]}-${start[2]}-${start[1]}` : null;
    return [
      {
        source_id: source.id,
        native_id: native,
        source_event_id: "mit:" + native,
        canonical_url: "https://scioperi.mit.gov.it/mit2/public/scioperi",
        title,
        original_language: "it",
        published_at: null,
        source_updated_at: null,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          { id: "calendar", text: plain(channel.title) },
          { id: "title", text: title },
          ...(body ? [{ id: "record", text: body }] : []),
        ],
        official: { issuer: source.owner, effective_at: iso, expires_at: null },
        priority: 100,
      },
    ];
  });
}

/** One current-feed burst per explicit police episode; never claims to include the complete episode history. */
export function coalesceNorwayEpisodes(
  observations: ObservationInput[],
): ObservationInput[] {
  const groups = new Map<string, ObservationInput[]>();
  for (const observation of observations) {
    const id = observation.source_event_id ?? observation.native_id;
    groups.set(id, [...(groups.get(id) ?? []), observation]);
  }
  return [...groups.values()].map((group) => {
    if (!group[0].source_event_id) return group[0];
    const chronological = [...group].sort(
      (a, b) =>
        (Date.parse(a.published_at ?? "") || Number.MAX_SAFE_INTEGER) -
          (Date.parse(b.published_at ?? "") || Number.MAX_SAFE_INTEGER) ||
        a.canonical_url.localeCompare(b.canonical_url),
    );
    const sorted = [...group].sort(
      (a, b) =>
        (Date.parse(a.published_at ?? "") || 0) -
          (Date.parse(b.published_at ?? "") || 0) ||
        Number(
          new URL(a.canonical_url).pathname.match(/\/(\d+)\/?$/)?.[1] ?? 0,
        ) -
          Number(
            new URL(b.canonical_url).pathname.match(/\/(\d+)\/?$/)?.[1] ?? 0,
          ) ||
        a.canonical_url.localeCompare(b.canonical_url),
    );
    const dates = group
      .map((o) => o.published_at)
      .filter((v): v is string => !!v)
      .sort();
    const updates = group
      .map((o) => o.source_updated_at ?? o.published_at)
      .filter((v): v is string => !!v)
      .sort();
    const seen = new Set<string>();
    const excerpts: ObservationInput["excerpts"] = [];
    for (const o of sorted) {
      for (const e of o.excerpts) {
        if (!e.text || seen.has(e.text)) continue;
        seen.add(e.text);
        excerpts.push({
          id: `${o.native_id}:${e.id}`,
          text: `Source message published: ${o.published_at ?? "unknown"}\n${e.text}`,
        });
      }
    }
    return {
      ...chronological[0],
      native_id: group[0].source_event_id!,
      source_event_id: group[0].source_event_id,
      excerpts,
      input_coverage: "permitted_excerpt",
      published_at: dates[0] ?? null,
      source_updated_at: updates.at(-1) ?? null,
      source_reports: sorted.map((o) => ({
        native_id: o.native_id,
        canonical_url: o.canonical_url,
        published_at: o.published_at,
      })),
    };
  });
}

/** API-only excerpts. Website articles/photos are deliberately not fetched. */
export function parseSwedenPolice(
  source: SourceRecord,
  json: string,
): ObservationInput[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw Error("invalid_sweden_police_api");
  return data.flatMap((v: any) => {
    if (
      !Number.isSafeInteger(v.id) ||
      typeof v.name !== "string" ||
      typeof v.summary !== "string" ||
      typeof v.type !== "string"
    )
      return [];
    const canonical = safeLink(
      typeof v.url === "string"
        ? new URL(v.url, "https://polisen.se").href
        : source.url,
      source.url,
    );
    const suppliedTime = typeof v.datetime === "string" ? v.datetime : "";
    const timestamp =
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(suppliedTime)
        ? date(suppliedTime.replace(" ", "T").replace(/ ([+-])/u, "$1"))
        : null;
    return [
      {
        source_id: source.id,
        native_id: String(v.id),
        source_event_id: "polisen:" + v.id,
        canonical_url: canonical,
        title: v.name,
        original_language: "sv",
        published_at: null,
        source_updated_at: null,
        input_coverage: "permitted_excerpt" as const,
        excerpts: [
          { id: "title", text: v.name },
          { id: "summary", text: v.summary },
          { id: "event_type", text: v.type },
          { id: "event_datetime", text: suppliedTime },
          ...(v.location
            ? [
                {
                  id: "source_administrative_area",
                  text: JSON.stringify(v.location),
                },
                {
                  id: "geography_precision",
                  text: "Municipality/county centroid; not incident location.",
                },
              ]
            : []),
        ],
        official: {
          issuer: source.owner,
          effective_at: timestamp,
          expires_at: null,
        },
        priority: 80,
      },
    ];
  });
}

/** Municipal event records only. Public-gathering admission is separate from broad traffic types. */
export function parseParisEvents(
  source: SourceRecord,
  json: string,
): ObservationInput[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data.results)) throw Error("invalid_paris_events_json");
  return data.results.flatMap((v: any) => {
    if (typeof v.id !== "string" || typeof v.description !== "string")
      return [];
    const event = {
      id: v.id,
      starttime: v.starttime ?? null,
      endtime: v.endtime ?? null,
      description: v.description,
      type: v.type ?? null,
      subtype: v.subtype ?? null,
      street: v.street ?? null,
      polyline: v.polyline ?? null,
      direction: v.direction ?? null,
    };
    return [
      {
        source_id: source.id,
        native_id: v.id,
        source_event_id: "paris-lutece:" + v.id,
        canonical_url:
          "https://opendata.paris.fr/explore/dataset/circulation_evenement/table/?refine.id=" +
          encodeURIComponent(v.id),
        title: v.description,
        original_language: "fr",
        published_at: null,
        source_updated_at: null,
        input_coverage: "full_licensed_text" as const,
        excerpts: [
          { id: "description", text: v.description },
          { id: "event", text: JSON.stringify(event) },
          {
            id: "geographic_scope",
            text: "Paris — source dataset geographic territory",
          },
        ],
        official: {
          issuer: source.owner,
          effective_at: date(v.starttime),
          expires_at: date(v.endtime),
        },
        priority: 100,
      },
    ];
  });
}
