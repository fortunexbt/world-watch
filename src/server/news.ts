import {
  isNewsCategory,
  NEWS_CATEGORIES,
  type NewsArticle,
  type NewsCategory,
  type NewsPlace,
  type NewsSignal,
  type NewsSignalCatalog,
} from "../shared/news";
import { lonOverlaps } from "./geo";
type Statement = {
  bind(...v: any[]): Statement;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<any>;
};
export type NewsContext = {
  stmt: (sql: string, ...values: any[]) => Statement;
  batch: (statements: Statement[]) => Promise<unknown>;
};
/** Distinct new headlines by GDELT source and UTC hour. */
type Hours = Record<string, Record<string, number>>;
type Row = {
  id: string;
  place: NewsPlace;
  hours: Hours;
  articles: NewsArticle[];
};

/** The window a signal describes, against the days before it. */
export const WINDOW_HOURS = 6;
const BASELINE_DAYS = 7;
/** Twelve hours of a stream's files before its share of a place's usual coverage is stated. */
const MIN_BASELINE_FILES = 48;
const KEEP_ARTICLES = 100;
const RISING_RATIO = 3;
const RISING_SOURCES = 3;
/**
 * Replays of live files on 23 October: at three headlines and half a day of history, 61 of
 * 100 listed places were rising, mostly places with no history yet; at five headlines with
 * 20 hours of history, 11 were.
 */
const RISING_STORIES = 5;
/** One outlet's coverage is not a signal; two domains is the floor for listing a place. */
const LIST_SOURCES = 2;
const LIST_LIMIT = 100;
const CANDIDATES = 300;
export const GDELT_ATTRIBUTION =
  "The GDELT Project (https://www.gdeltproject.org/). Machine-geocoded news coverage, not verified events; headlines and links belong to their publishers.";
export const GDELT_TERMS_URL =
  "https://www.gdeltproject.org/about.html#termsofuse";

const iso = (n: number) => new Date(n).toISOString();
const hourKey = (at: string) => at.slice(0, 13);
const json = (value: string) => JSON.parse(value);
/** A headline as one story: syndicated copies append their outlet after " | " or a dash. */
export const storyKey = (a: Pick<NewsArticle, "title" | "url">) =>
  a.title
    ? a.title
        .split(" | ")[0]
        .replace(/\s+[-–—]\s+[^-–—]{1,60}$/u, "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .slice(0, 80)
    : a.url;

function windowBounds(clock: number) {
  const start =
    Math.floor(clock / 3600000) * 3600000 - (WINDOW_HOURS - 1) * 3600000;
  return {
    start: iso(start),
    startHour: hourKey(iso(start)),
    baselineHour: hourKey(iso(start - BASELINE_DAYS * 86400000)),
  };
}

/**
 * Coverage in the window against the place's own baseline, counted in distinct headlines so
 * one wire story syndicated by many outlets counts once. Each GDELT stream's expectation is
 * its headlines per ingested file before the window times its files in the window, so a
 * collection gap or a stream outage lowers both sides alike. Every stream with files in the
 * window needs its own baseline. A place GDELT never placed before has a zero baseline,
 * which add-one smoothing keeps finite.
 */
export function rankSignal(
  row: Row,
  files: Hours,
  clock = Date.now(),
): NewsSignal | null {
  const { start, startHour, baselineHour } = windowBounds(clock);
  const sum = (counts: Record<string, number> = {}, from: string, to = "~") =>
    Object.entries(counts).reduce(
      (n, [hour, v]) => (hour >= from && hour < to ? n + v : n),
      0,
    );
  let stories = 0,
    expected: number | null = 0,
    priorFiles = 0;
  for (const source of new Set([
    ...Object.keys(row.hours),
    ...Object.keys(files),
  ])) {
    const windowFiles = sum(files[source], startHour),
      sourceFiles = sum(files[source], baselineHour, startHour);
    stories += sum(row.hours[source], startHour);
    priorFiles += sourceFiles;
    if (!windowFiles || expected === null) continue;
    expected =
      sourceFiles >= MIN_BASELINE_FILES
        ? expected +
          (sum(row.hours[source], baselineHour, startHour) / sourceFiles) *
            windowFiles
        : null;
  }
  const recent = row.articles.filter((a) => a.seen_at >= start);
  if (!stories || !recent.length) return null;
  const domains = new Map<string, number>(),
    categories: Partial<Record<NewsCategory, number>> = {};
  for (const a of recent) {
    domains.set(a.domain, (domains.get(a.domain) ?? 0) + 1);
    for (const c of a.categories) categories[c] = (categories[c] ?? 0) + 1;
  }
  const category = NEWS_CATEGORIES.reduce((best, c) =>
      (categories[c] ?? 0) > (categories[best] ?? 0) ? c : best,
    ),
    baseline =
      expected === null || !priorFiles
        ? null
        : { expected: Math.round(expected * 10) / 10, files: priorFiles },
    ratio = baseline ? (stories + 1) / (expected! + 1) : null,
    tones = recent.flatMap((a) => (a.tone === null ? [] : [a.tone]));
  return {
    id: "gdelt:" + row.id,
    place: row.place,
    category,
    categories,
    window_start: start,
    window_end: iso(clock),
    articles_count: recent.length,
    sources_count: domains.size,
    stories_count: stories,
    truncated: recent.length >= KEEP_ARTICLES,
    baseline,
    ratio,
    rising:
      ratio !== null &&
      ratio >= RISING_RATIO &&
      domains.size >= RISING_SOURCES &&
      stories >= RISING_STORIES,
    // Poisson excess over the expectation once there is a baseline; distinct headlines before.
    score: baseline
      ? (stories - expected!) / Math.sqrt(Math.max(expected!, 1))
      : stories,
    tone: tones.length
      ? Math.round((tones.reduce((a, b) => a + b, 0) / tones.length) * 10) / 10
      : null,
    top_sources: [...domains]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([domain, n]) => ({ domain, articles: n })),
    articles: recent.slice(0, 20),
  };
}

async function filesByHour(c: NewsContext, clock: number) {
  const { baselineHour } = windowBounds(clock);
  const files: Hours = {};
  for (const r of (
    await c
      .stmt(
        "SELECT source_id,substr(file_at,1,13) AS hour,count(*) AS files FROM news_files WHERE file_at>=? GROUP BY source_id,hour",
        baselineHour,
      )
      .all<{ source_id: string; hour: string; files: number }>()
  ).results)
    (files[r.source_id] ??= {})[r.hour] = Number(r.files);
  return files;
}

async function gdeltSources(c: NewsContext) {
  return (
    await c
      .stmt(
        "SELECT record FROM sources WHERE json_extract(record,'$.config.format')='gdelt_gkg'",
      )
      .all<{ record: string }>()
  ).results.map((r) => json(r.record));
}

const text = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max ? v : null;
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Rebuilds an article from its permitted fields, so nothing else a collector sends is stored. */
function article(v: any, fileAt: string): NewsArticle {
  const url = text(v?.url, 1000);
  let parsed: URL | null = null;
  try {
    parsed = url ? new URL(url) : null;
  } catch {}
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !/^[a-z0-9.-]{1,253}$/.test(v.domain) ||
    !/^[a-z]{3}$/.test(v.language) ||
    (v.title !== null && !text(v.title, 300)) ||
    (v.tone !== null && !finite(v.tone)) ||
    !Array.isArray(v.categories) ||
    !v.categories.length ||
    !v.categories.every(isNewsCategory) ||
    !Array.isArray(v.themes) ||
    v.themes.length > 12 ||
    !v.themes.every(
      (t: unknown) => typeof t === "string" && /^[A-Z0-9_]{1,80}$/.test(t),
    )
  )
    throw Error("invalid_news_article");
  return {
    url: url!,
    title: v.title,
    domain: v.domain,
    language: v.language,
    tone: v.tone,
    seen_at: fileAt,
    categories: [...new Set(v.categories as NewsCategory[])],
    themes: [...new Set(v.themes as string[])],
  };
}
function place(v: any): NewsPlace {
  if (
    !/^-?[0-9A-Za-z]{1,20}$/.test(v?.id) ||
    !text(v.name, 200) ||
    !finite(v.lat) ||
    !finite(v.lon) ||
    Math.abs(v.lat) > 90 ||
    Math.abs(v.lon) > 180 ||
    (v.country !== null && !/^[A-Z]{2}$/.test(v.country))
  )
    throw Error("invalid_news_place");
  return { id: v.id, name: v.name, lat: v.lat, lon: v.lon, country: v.country };
}

/** One GDELT file, once. Counts accumulate per place and hour; only the window's articles are kept. */
export async function ingestNews(
  c: NewsContext,
  batch: any,
  clock = Date.now(),
) {
  const record = (await gdeltSources(c)).find((s) => s.id === batch?.source_id);
  if (!record) throw Error("unknown_source");
  if (!record.rights.access || !record.rights.storage)
    throw Error("source_storage_not_permitted");
  const fileAt = text(batch.file_at, 24),
    at = fileAt ? Date.parse(fileAt) : NaN,
    retention =
      Math.max(1, Number(record.rights.retention_days) || 0) * 86400000;
  if (
    !fileAt ||
    iso(at) !== fileAt ||
    at % 900000 !== 0 ||
    at > clock + 3600000 ||
    at < clock - retention ||
    !Array.isArray(batch.places) ||
    batch.places.length > 5000
  )
    throw Error("invalid_news_batch");
  const places = new Map<
    string,
    { place: NewsPlace; articles: NewsArticle[] }
  >();
  for (const p of batch.places) {
    if (
      !Array.isArray(p?.articles) ||
      !p.articles.length ||
      p.articles.length > 500
    )
      throw Error("invalid_news_place");
    const value = place(p);
    if (places.has(value.id)) throw Error("duplicate_news_place");
    places.set(value.id, {
      place: value,
      articles: [
        ...new Map(
          p.articles.map((a: unknown) => {
            const v = article(a, fileAt);
            return [v.url, v];
          }),
        ).values(),
      ] as NewsArticle[],
    });
  }
  if (
    await c
      .stmt(
        "SELECT 1 FROM news_files WHERE source_id=? AND file_at=?",
        record.id,
        fileAt,
      )
      .first()
  )
    return { duplicate: true, places: 0 };
  // One read and one write for the whole file: D1 counts every statement against a per-request query limit.
  const existing = new Map<string, Row>(
    (
      await c
        .stmt(
          "SELECT id,place,hours,articles FROM news_places WHERE id IN(SELECT value FROM json_each(?))",
          JSON.stringify([...places.keys()]),
        )
        .all<any>()
    ).results.map((r) => [
      r.id,
      {
        id: r.id,
        place: json(r.place),
        hours: json(r.hours),
        articles: json(r.articles),
      },
    ]),
  );
  const coverage = await filesByHour(c, clock),
    hour = hourKey(fileAt),
    { start, baselineHour } = windowBounds(clock),
    time = iso(clock);
  (coverage[record.id] ??= {})[hour] = (coverage[record.id][hour] ?? 0) + 1;
  const rows = [...places].map(([id, { place, articles }]) => {
    const prior = existing.get(id),
      seen = new Set(
        prior?.articles.filter((a) => a.seen_at >= start).map(storyKey),
      ),
      known = new Set(articles.map((a) => a.url));
    const hours: Hours = Object.fromEntries(
      Object.entries(prior?.hours ?? {}).map(([source, counts]) => [
        source,
        Object.fromEntries(
          Object.entries(counts).filter(([h]) => h >= baselineHour),
        ),
      ]),
    );
    // A headline already counted in the window, from any outlet or a later GDELT file, counts once.
    const added = new Set(
      articles.map(storyKey).filter((key) => !seen.has(key)),
    ).size;
    if (added)
      (hours[record.id] ??= {})[hour] = (hours[record.id][hour] ?? 0) + added;
    const row: Row = {
      id,
      // The first name GDELT gave a feature stays, so one place keeps one label.
      place: prior?.place ?? place,
      hours,
      articles: [
        ...articles,
        ...(prior?.articles ?? []).filter((a) => !known.has(a.url)),
      ]
        .filter((a) => a.seen_at >= start)
        .sort((a, b) => b.seen_at.localeCompare(a.seen_at))
        .slice(0, KEEP_ARTICLES),
    };
    return { ...row, score: rankSignal(row, coverage, clock)?.score ?? 0 };
  });
  const statements = [
    c.stmt(
      "INSERT INTO news_files(source_id,file_at,ingested_at,articles) VALUES(?,?,?,?)",
      record.id,
      fileAt,
      time,
      [...places.values()].reduce((n, p) => n + p.articles.length, 0),
    ),
    c.stmt(
      "INSERT INTO news_places(id,place,hours,articles,score,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.place'),json_extract(value,'$.hours'),json_extract(value,'$.articles'),json_extract(value,'$.score'),? FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET place=excluded.place,hours=excluded.hours,articles=excluded.articles,score=excluded.score,updated_at=excluded.updated_at",
      time,
      JSON.stringify(rows),
    ),
    c.stmt(
      "DELETE FROM news_places WHERE updated_at<?",
      iso(clock - retention),
    ),
    c.stmt("DELETE FROM news_files WHERE file_at<?", iso(clock - retention)),
  ];
  await c.batch(statements);
  return { duplicate: false, places: places.size };
}

/** Places ranked by unusual coverage. Nothing is listed unless every GDELT source still permits display. */
export async function newsCatalog(
  c: NewsContext,
  bbox: number[] | null = null,
  clock = Date.now(),
): Promise<NewsSignalCatalog> {
  const sources = await gdeltSources(c),
    { start, startHour } = windowBounds(clock),
    catalog: NewsSignalCatalog = {
      signals: [],
      coverage: {
        window_hours: WINDOW_HOURS,
        window_files: 0,
        baseline_files: 0,
        first_file_at: null,
        last_file_at: null,
      },
      attribution: GDELT_ATTRIBUTION,
      license_url: GDELT_TERMS_URL,
    };
  if (
    !sources.length ||
    !sources.every(
      (s) => s.rights.access && s.rights.storage && s.rights.display,
    )
  )
    return catalog;
  const coverage = await filesByHour(c, clock),
    files = await c
      .stmt("SELECT min(file_at) AS first,max(file_at) AS last FROM news_files")
      .first<{ first: string | null; last: string | null }>();
  for (const counts of Object.values(coverage))
    for (const [hour, n] of Object.entries(counts))
      if (hour >= startHour) catalog.coverage.window_files += n;
      else catalog.coverage.baseline_files += n;
  catalog.coverage.first_file_at = files?.first ?? null;
  catalog.coverage.last_file_at = files?.last ?? null;
  catalog.signals = (
    await c
      .stmt(
        "SELECT id,place,hours,articles FROM news_places WHERE updated_at>=? ORDER BY score DESC LIMIT ?",
        start,
        CANDIDATES,
      )
      .all<any>()
  ).results
    .map((r) =>
      rankSignal(
        {
          id: r.id,
          place: json(r.place),
          hours: json(r.hours),
          articles: json(r.articles),
        },
        coverage,
        clock,
      ),
    )
    .filter(
      (s): s is NewsSignal =>
        !!s &&
        s.sources_count >= LIST_SOURCES &&
        (!bbox ||
          (s.place.lat >= bbox[1] &&
            s.place.lat <= bbox[3] &&
            lonOverlaps(s.place.lon, 0, bbox[0], bbox[2]))),
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, LIST_LIMIT);
  return catalog;
}
