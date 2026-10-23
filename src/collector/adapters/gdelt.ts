import { countryAt } from "../../shared/borders.js";
import type {
  NewsArticle,
  NewsBatch,
  NewsCategory,
  NewsPlace,
} from "../../shared/news.js";

/**
 * GDELT 2.0 Global Knowledge Graph files, one every 15 minutes per stream. The GEO 2.0
 * API answered 404 on 22 October 2026 and the DOC API rate-limits to one request every
 * five seconds, so the collector reads the same geocoded GKG records from the raw files.
 */
const ROOT = "https://data.gdeltproject.org/gdeltv2/";
export const GDELT_STREAMS = {
  english: { lastupdate: ROOT + "lastupdate.txt", suffix: ".gkg.csv.zip" },
  translingual: {
    lastupdate: ROOT + "lastupdate-translation.txt",
    suffix: ".translation.gkg.csv.zip",
  },
} as const;
export type GdeltStream = keyof typeof GDELT_STREAMS;
const FILE_MS = 900000;
/**
 * The newest eight files, two hours, stay eligible. GDELT can list a file well before it can
 * be fetched (the translated stream ran 45 minutes behind its listing on 23 October), and a
 * fresh collector backfills the same two hours.
 */
const RECENT_FILES = 8;
const MAX_UNZIPPED = 192 * 1024 * 1024;
/** GKG themes by news category. Broad themes such as KILL or SECURITY_SERVICES mark too much ordinary coverage. */
// prettier-ignore
const THEMES: Record<string, NewsCategory> = {
  PROTEST: "protest", TAX_FNCACT_DEMONSTRATORS: "protest", TAX_FNCACT_DEMONSTRATOR: "protest",
  STRIKE: "strike", TAX_FNCACT_STRIKERS: "strike", TAX_FNCACT_STRIKER: "strike",
  ARMEDCONFLICT: "armed_conflict", REBELLION: "armed_conflict", INSURGENCY: "armed_conflict", SEIGE: "armed_conflict",
  TERROR: "attack", TAX_WEAPONS_BOMB: "attack", TAX_WEAPONS_BOMBS: "attack", TAX_WEAPONS_EXPLOSIVES: "attack",
  TAX_WEAPONS_SUICIDE_BOMBER: "attack", TAX_WEAPONS_SUICIDE_BOMBERS: "attack", TAX_WEAPONS_IMPROVISED_EXPLOSIVE: "attack",
  TAX_FNCACT_COUP_PLOTTERS: "coup", TAX_FNCACT_COUP_PLOTTER: "coup",
  REFUGEES: "displacement", DISPLACED: "displacement", CRISISLEX_T09_DISPLACEDRELOCATEDEVACUATED: "displacement",
  SOC_REFUGEECAMP: "displacement", SOC_POINTSOFINTEREST_REFUGEE_CAMP: "displacement", SOC_POINTSOFINTEREST_REFUGEE_CAMPS: "displacement",
  EVACUATION: "evacuation",
  STATE_OF_EMERGENCY: "emergency_measures", CURFEW: "emergency_measures",
  NATURAL_DISASTER: "disaster", MANMADE_DISASTER: "disaster",
};
const themeCategory = (theme: string) =>
  THEMES[theme] ??
  (theme.startsWith("NATURAL_DISASTER_") ? ("disaster" as const) : undefined);
/** A theme counts for a place only when GDELT found both within this many characters, about a sentence. */
const NEAR = 150;
const PLACES_PER_ARTICLE = 3;
/** GKG location types 3 and 4: a US or world city or landmark. Country and province centroids are not map points. */
const CITY_TYPES = new Set(["3", "4"]);

const stampTime = (stamp: string) => {
  const m = stamp.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/);
  const time = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
  if (
    !m ||
    !Number.isFinite(time) ||
    time % FILE_MS !== 0 ||
    stampOf(time) !== stamp
  )
    throw Error("invalid_gdelt_stamp");
  return time;
};
const stampOf = (time: number) =>
  new Date(time).toISOString().replace(/\D/g, "").slice(0, 14);

/**
 * The files still to read from a lastupdate listing, newest first. Only the listed
 * timestamp is taken from the listing; file URLs are rebuilt on the approved origin.
 */
export function gdeltFiles(
  listing: string,
  stream: GdeltStream,
  done: string[] = [],
) {
  const { suffix } = GDELT_STREAMS[stream];
  const match = listing.match(
    new RegExp(
      `^\\d+ [0-9a-f]{32} https?://data\\.gdeltproject\\.org/gdeltv2/(\\d{14})${suffix.replaceAll(".", "\\.")}\\r?$`,
      "m",
    ),
  );
  if (!match) throw Error("invalid_gdelt_lastupdate");
  const latest = stampTime(match[1]);
  const recent = Array.from({ length: RECENT_FILES }, (_, i) =>
    stampOf(latest - i * FILE_MS),
  );
  return {
    recent,
    pending: recent
      .filter((stamp) => !done.includes(stamp))
      .map((stamp) => ({
        stamp,
        file_at: new Date(stampTime(stamp)).toISOString(),
        url: ROOT + stamp + suffix,
      })),
  };
}

/** The lines of a single-entry deflate ZIP, decompressed as a stream with a size cap. */
export async function* zipLines(bytes: Uint8Array<ArrayBuffer>) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30 || view.getUint32(0, true) !== 0x04034b50)
    throw Error("invalid_gdelt_zip");
  const flags = view.getUint16(6, true),
    method = view.getUint16(8, true),
    size = view.getUint32(18, true),
    start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  // Encryption, sizes deferred to a data descriptor and methods other than deflate are not GDELT's layout.
  if (method !== 8 || flags & 0x09 || !size || start + size > bytes.length)
    throw Error("invalid_gdelt_zip");
  const reader = new Blob([bytes.subarray(start, start + size)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const decoder = new TextDecoder();
  let total = 0,
    pending = "";
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if ((total += r.value.length) > MAX_UNZIPPED)
        throw Error("gdelt_unzipped_size_limit");
      const lines = (pending + decoder.decode(r.value, { stream: true })).split(
        "\n",
      );
      pending = lines.pop()!;
      if (pending.length > 4 * 1024 * 1024) throw Error("gdelt_record_limit");
      yield* lines;
    }
    pending += decoder.decode();
    if (pending) yield pending;
  } finally {
    await reader.cancel();
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function headline(extras: string) {
  const raw = extras.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/s)?.[1];
  if (!raw) return null;
  const title = raw
    .replace(
      /&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]+));/gi,
      (all, hex, dec, name) => {
        const code = hex ? parseInt(hex, 16) : dec ? Number(dec) : null;
        if (code === null) return ENTITIES[name.toLowerCase()] ?? all;
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      },
    )
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  return title ? title.slice(0, 300).replace(/[\uD800-\uDBFF]$/, "") : null;
}

/**
 * One GKG 2.1 record: the article's link, headline and GDELT metadata, and each city-level
 * place GDELT found near a matched theme. Records without both are not news signals.
 */
export function gkgRecord(line: string) {
  const c = line.split("\t");
  // Collection 1 is the open web; the others are citation-only or licensed corpora without a link.
  if (c.length !== 27 || c[2] !== "1") return null;
  const url = c[4],
    domain = c[3].toLowerCase();
  if (
    url.length > 1000 ||
    !/^https?:\/\/\S+$/.test(url) ||
    !/^[a-z0-9.-]{1,253}$/.test(domain)
  )
    return null;
  const themes = c[8].split(";").flatMap((entry) => {
    const cut = entry.lastIndexOf(","),
      theme = entry.slice(0, cut),
      category = themeCategory(theme),
      offset = Number(entry.slice(cut + 1));
    return category && cut > 0 && Number.isSafeInteger(offset)
      ? [{ theme, category, offset }]
      : [];
  });
  if (!themes.length) return null;
  const near = new Map<
    string,
    { place: NewsPlace; distance: number; themes: typeof themes }
  >();
  for (const entry of c[10].split(";")) {
    const [type, name, , , , lat, lon, id, at] = entry.split("#");
    const offset = Number(at),
      y = Number(lat),
      x = Number(lon);
    if (
      !CITY_TYPES.has(type) ||
      !/^-?\d{1,12}$/.test(id ?? "") ||
      !Number.isSafeInteger(offset) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 180 ||
      Math.abs(y) > 90 ||
      (x === 0 && y === 0)
    )
      continue;
    const close = themes.filter((t) => Math.abs(t.offset - offset) <= NEAR);
    if (!close.length) continue;
    const distance = Math.min(...close.map((t) => Math.abs(t.offset - offset)));
    const prior = near.get(id);
    near.set(id, {
      place: prior?.place ?? {
        id,
        name: name
          .split(", ")
          .filter((part) => part && !part.endsWith("(General)"))
          .join(", ")
          .slice(0, 200),
        lat: y,
        lon: x,
        // GDELT states FIPS codes; the map's own boundaries give the ISO code, or none near a coast or border.
        country: countryAt(x, y),
      },
      distance: Math.min(distance, prior?.distance ?? Infinity),
      themes: [...(prior?.themes ?? []), ...close],
    });
  }
  if (!near.size) return null;
  const tone = Number(c[15].split(",")[0]);
  return {
    url,
    title: headline(c[26]),
    domain,
    language: c[25].match(/(?:^|;)srclc:([a-z]{3})(?:;|$)/)?.[1] ?? "eng",
    tone: Number.isFinite(tone) && c[15] ? Math.round(tone * 100) / 100 : null,
    places: [...near.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, PLACES_PER_ARTICLE)
      .map((p) => ({
        place: p.place,
        categories: [...new Set(p.themes.map((t) => t.category))],
        themes: [...new Set(p.themes.map((t) => t.theme))].slice(0, 12),
      })),
  };
}

/** A GDELT file's matched articles grouped by place, ready for the news ingest endpoint. */
export async function gkgBatch(
  sourceId: string,
  fileAt: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const places = new Map<string, NewsPlace & { articles: NewsArticle[] }>();
  let records = 0,
    matched = 0;
  for await (const line of zipLines(bytes)) {
    if (!line) continue;
    records++;
    const record = gkgRecord(line);
    if (!record) continue;
    matched++;
    for (const { place, categories, themes } of record.places) {
      const entry = places.get(place.id) ?? { ...place, articles: [] };
      // The ingest endpoint takes 500 articles per place and file, far above any file read so far.
      if (
        entry.articles.length >= 500 ||
        entry.articles.some((a) => a.url === record.url)
      )
        continue;
      entry.articles.push({
        url: record.url,
        title: record.title,
        domain: record.domain,
        language: record.language,
        tone: record.tone,
        seen_at: fileAt,
        categories,
        themes,
      });
      places.set(place.id, entry);
    }
  }
  if (!records) throw Error("empty_gdelt_file");
  const batch: NewsBatch = {
    source_id: sourceId,
    file_at: fileAt,
    places: [...places.values()],
  };
  return { batch, records, matched };
}
