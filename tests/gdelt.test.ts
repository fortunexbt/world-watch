import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { crc32, deflateRawSync } from "node:zlib";
import { chromium } from "@playwright/test";
import {
  GDELT_STREAMS,
  gdeltFiles,
  gkgBatch,
  gkgRecord,
  zipLines,
} from "../src/collector/adapters/gdelt.js";
import { collectSources } from "../src/collector/index.js";
import { configuredRegistry, sourceRegistry } from "../src/collector/registry.js";
import server, { type Env } from "../src/server/index.js";
import { rankSignal, storyKey } from "../src/server/news.js";
import { structuredBrief } from "../src/server/structured-brief.js";
import { translate } from "../src/client/locale.js";
import { NEWS_LABELS } from "../src/client/NewsSignals.js";
import { NEWS_CATEGORIES, type NewsArticle, type NewsSignal } from "../src/shared/news.js";
import type { FetchState } from "../src/collector/fetch.js";

// Real GKG 2.1 records from the 22 October 2026 14:00 to 14:45 UTC files, trimmed to the
// columns World Watch reads, and the lastupdate listing GDELT served at 23 October 00:00 UTC.
// Source: The GDELT Project, https://www.gdeltproject.org/ ; headlines and links belong to their publishers.
const english = readFileSync("tests/fixtures/gdelt-gkg.tsv", "utf8");
const translated = readFileSync("tests/fixtures/gdelt-gkg-translation.tsv", "utf8");
const listing = readFileSync("tests/fixtures/gdelt-lastupdate.txt", "utf8");
const englishSource = sourceRegistry.find((s) => s.id === "global-gdelt-news-english")!;
const translatedSource = sourceRegistry.find((s) => s.id === "global-gdelt-news-translingual")!;
const ARTICLE_KEYS = ["categories", "domain", "language", "seen_at", "themes", "title", "tone", "url"];

/** A single-entry deflate ZIP laid out as GDELT's files are. */
function zip(name: string, text: string | Buffer) {
  const data = deflateRawSync(typeof text === "string" ? Buffer.from(text) : text),
    header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(text), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(Buffer.byteLength(text), 22);
  header.writeUInt16LE(name.length, 26);
  return new Uint8Array(Buffer.concat([header, Buffer.from(name), data]));
}

test("the GDELT sources are worldwide discovery with storage and display but no model use or redistribution", () => {
  for (const s of [englishSource, translatedSource]) {
    assert.equal(s.status, "enabled");
    assert.equal(s.family, "gdelt");
    assert.deepEqual(s.countries, ["*"]);
    assert.equal(s.config.format, "gdelt_gkg");
    assert.deepEqual(
      [s.rights.access, s.rights.storage, s.rights.display, s.rights.ai, s.rights.redistribute],
      [true, true, true, false, false],
    );
    assert.match(s.rights.basis, /gdeltproject\.org\/about\.html#termsofuse/);
    assert.match(s.rights.attribution, /The GDELT Project, https:\/\/www\.gdeltproject\.org\//);
    assert.ok(configuredRegistry({ countries: ["PE"] }).some((r) => r.id === s.id));
  }
  assert.equal(englishSource.url, GDELT_STREAMS.english.lastupdate);
  assert.equal(translatedSource.url, GDELT_STREAMS.translingual.lastupdate);
});

test("a lastupdate listing yields the newest unread files, rebuilt on the approved HTTPS origin", () => {
  const { recent, pending } = gdeltFiles(listing, "english");
  assert.equal(recent.length, 8);
  assert.deepEqual(recent.slice(0, 2), ["20261023000000", "20261022234500"]);
  assert.equal(recent.at(-1), "20261022221500");
  assert.equal(pending.length, 8);
  assert.deepEqual(pending.slice(0, 2), [
    {
      stamp: "20261023000000",
      file_at: "2026-10-23T00:00:00.000Z",
      url: "https://data.gdeltproject.org/gdeltv2/20261023000000.gkg.csv.zip",
    },
    {
      stamp: "20261022234500",
      file_at: "2026-10-22T23:45:00.000Z",
      url: "https://data.gdeltproject.org/gdeltv2/20261022234500.gkg.csv.zip",
    },
  ]);
  assert.deepEqual(
    gdeltFiles(listing, "english", ["20261023000000", "20261022233000"]).pending.map((f) => f.stamp).slice(0, 3),
    ["20261022234500", "20261022231500", "20261022230000"],
  );
  assert.throws(() => gdeltFiles(listing, "translingual"), /invalid_gdelt_lastupdate/);
  assert.throws(
    () => gdeltFiles(listing.replace("20261023000000.gkg", "20261023000700.gkg"), "english"),
    /invalid_gdelt_stamp/,
  );
  assert.throws(
    () => gdeltFiles(listing.replaceAll("data.gdeltproject.org", "evil.example"), "english"),
    /invalid_gdelt_lastupdate/,
  );
});

test("a theme counts for a city only when GDELT found the two within a sentence of each other", () => {
  const rows = english.trim().split("\n");
  const byId = (id: string) => rows.find((r) => r.startsWith(id + "\t"))!;
  const looting = gkgRecord(byId("20261022140000-810"))!;
  assert.equal(looting.title, "French authorities ban some student protests after weekend looting and clashes");
  assert.equal(looting.domain, "wsls.com");
  assert.equal(looting.language, "eng");
  const paris = looting.places.find((p) => p.place.name === "Paris, France")!;
  assert.deepEqual(paris.place, { id: "-1456928", name: "Paris, France", lat: 48.8667, lon: 2.33333, country: "FR" });
  assert.ok(paris.categories.includes("protest"));
  assert.ok(paris.themes.includes("PROTEST"));
  assert.ok(looting.places.length <= 3);
  // Country and province centroids are never map points.
  for (const row of rows)
    for (const p of gkgRecord(row)?.places ?? []) assert.match(p.place.id, /^-?\d+$/);
  // A non-web collection has no public link.
  assert.equal(gkgRecord(byId("20261022140000-810").replace("\t1\twsls.com", "\t2\twsls.com")), null);
  const unmatched = rows.filter((r) => !gkgRecord(r));
  assert.ok(unmatched.length >= 4, "records without a nearby theme and city are dropped");
  const curfew = gkgRecord(translated.split("\n").find((r) => r.includes("toque-de-queda"))!)!;
  assert.equal(curfew.title, "La Policía anuncia un tercer toque de queda nocturno para partes de París");
  assert.equal(curfew.language, "spa");
});

test("a GDELT file groups its matched articles by place, keeping links, headlines and GDELT metadata only", async () => {
  const { batch, records, matched } = await gkgBatch(
    englishSource.id,
    "2026-10-22T14:45:00.000Z",
    zip("20261022144500.gkg.csv", english),
  );
  assert.equal(records, 23);
  assert.equal(matched, 12);
  const paris = batch.places.find((p) => p.id === "-1456928")!;
  assert.ok(paris.articles.length >= 8);
  assert.equal(new Set(paris.articles.map((a) => a.url)).size, paris.articles.length);
  for (const place of batch.places)
    for (const a of place.articles) {
      assert.deepEqual(Object.keys(a).sort(), ARTICLE_KEYS);
      assert.equal(a.seen_at, "2026-10-22T14:45:00.000Z");
      assert.ok(a.categories.every((c) => (NEWS_CATEGORIES as readonly string[]).includes(c)));
    }
  const kyiv = batch.places.find((p) => p.name.startsWith("Kyiv"))!;
  assert.ok(kyiv.articles.some((a) => a.categories.includes("armed_conflict")));
  const translatedBatch = (
    await gkgBatch(translatedSource.id, "2026-10-22T14:00:00.000Z", zip("t.csv", translated))
  ).batch;
  assert.ok(translatedBatch.places.some((p) => p.articles.some((a) => a.language === "ita" && a.categories.includes("evacuation"))));
});

test("only a deflated single-entry ZIP within the size cap is read", async () => {
  const read = async (bytes: Uint8Array<ArrayBuffer>) => {
    const lines = [];
    for await (const line of zipLines(bytes)) lines.push(line);
    return lines;
  };
  const good = zip("x.csv", "a\nb\n");
  assert.deepEqual(await read(good), ["a", "b"]);
  const stored = good.slice();
  new DataView(stored.buffer).setUint16(8, 0, true);
  await assert.rejects(read(stored), /invalid_gdelt_zip/);
  const deferred = good.slice();
  new DataView(deferred.buffer).setUint16(6, 0x08, true);
  await assert.rejects(read(deferred), /invalid_gdelt_zip/);
  await assert.rejects(read(new TextEncoder().encode("<html>not found</html>")), /invalid_gdelt_zip/);
  // 200 MB of 1 MB lines: under the per-record cap, over the file cap.
  const bomb = Buffer.alloc(200 * 1024 * 1024, "x");
  for (let i = 1024 * 1024 - 1; i < bomb.length; i += 1024 * 1024) bomb[i] = 10;
  await assert.rejects(read(zip("bomb.csv", bomb)), /gdelt_unzipped_size_limit/);
});

const article = (n: number, over: Partial<NewsArticle> = {}): NewsArticle => ({
  url: `https://news${n % 12}.example/story/${n}`,
  title: `Story ${n % 9}`,
  domain: `news${n % 12}.example`,
  language: "eng",
  tone: -4,
  seen_at: "2026-10-23T09:00:00.000Z",
  categories: ["protest"],
  themes: ["PROTEST"],
  ...over,
});
const place = { id: "-1", name: "Lima, Lima, Peru", lat: -12.05, lon: -77.05, country: "PE" };
const hourAgo = (clock: number, i: number) => new Date(clock - i * 3600000).toISOString().slice(0, 13);
/** Hourly GDELT file counts, four files an hour, for the hours before the clock. */
const span = (clock: number, from: number, to: number) =>
  Object.fromEntries(Array.from({ length: to - from }, (_, i) => [hourAgo(clock, from + i), 4]));
const week = (clock: number, hours = 168) => ({
  [englishSource.id]: span(clock, 0, hours),
  [translatedSource.id]: span(clock, 0, hours),
});

test("spike ranking compares a place's window with its own baseline and surfaces what is new", () => {
  const clock = Date.parse("2026-10-23T10:20:00Z"),
    coverage = week(clock),
    hours = (window: number, prior: number) => ({
      [englishSource.id]: Object.fromEntries([
        ...Array.from({ length: 6 }, (_, i) => [hourAgo(clock, i), window]),
        ...Array.from({ length: 150 }, (_, i) => [hourAgo(clock, i + 7), prior]),
      ]),
    });
  const articles = Array.from({ length: 40 }, (_, i) => article(i));
  const usual = rankSignal({ id: "-2", place, hours: hours(8, 8), articles }, coverage, clock)!;
  assert.equal(usual.rising, false);
  assert.ok(usual.ratio! > 0.9 && usual.ratio! < 1.1);
  const spike = rankSignal({ id: "-1", place, hours: hours(8, 0), articles }, coverage, clock)!;
  assert.equal(spike.rising, true);
  assert.equal(spike.articles_count, 40);
  assert.equal(spike.sources_count, 12);
  assert.equal(spike.stories_count, 48);
  assert.equal(spike.truncated, false);
  assert.deepEqual(spike.baseline, { expected: 0, files: 1296 });
  assert.equal(spike.ratio, 49);
  assert.ok(spike.score > usual.score);
  assert.deepEqual(spike.top_sources[0], { domain: "news0.example", articles: 4 });
  // One outlet repeating itself is breadth one, however many copies it files.
  const echo = rankSignal(
    { id: "-3", place, hours: hours(8, 0), articles: articles.map((a) => ({ ...a, domain: "wire.example", title: "Same story | wire" })) },
    coverage,
    clock,
  )!;
  assert.equal(echo.sources_count, 1);
  assert.equal(echo.rising, false);
  // Each stream is compared with itself: a translated-stream outage now neither hides nor fakes a change.
  const outage = rankSignal(
    {
      id: "-2",
      place,
      hours: { ...hours(8, 8), [translatedSource.id]: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [hourAgo(clock, i + 7), 20])) },
      articles,
    },
    { ...coverage, [translatedSource.id]: span(clock, 6, 168) },
    clock,
  )!;
  assert.deepEqual([outage.baseline!.expected, outage.rising], [usual.baseline!.expected, false]);
  // A stream with files in the window but under 12 hours of earlier files leaves no baseline.
  const young = rankSignal(
    { id: "-1", place, hours: hours(8, 0), articles },
    { ...coverage, [translatedSource.id]: span(clock, 0, 10) },
    clock,
  )!;
  assert.equal(young.baseline, null);
  // Without 12 hours of earlier files there is no baseline to rise above.
  const cold = rankSignal({ id: "-1", place, hours: hours(8, 0), articles }, week(clock, 6), clock)!;
  assert.equal(cold.baseline, null);
  assert.equal(cold.ratio, null);
  assert.equal(cold.rising, false);
  assert.equal(cold.score, 48, "distinct headlines rank places before a baseline exists");
  // Articles that fell out of the window are not a signal.
  assert.equal(rankSignal({ id: "-1", place, hours: hours(0, 3), articles }, coverage, clock + 7 * 3600000), null);
});

test("the structured brief states a news signal only once it has risen above a baseline", () => {
  const clock = Date.parse("2026-10-23T10:20:00Z");
  const signal = {
    ...rankSignal(
      { id: "-1", place, hours: { [englishSource.id]: { "2026-10-23T09": 30 } }, articles: Array.from({ length: 30 }, (_, i) => article(i)) },
      week(clock),
      clock,
    )!,
  } as NewsSignal;
  assert.equal(signal.rising, true);
  const brief = structuredBrief([], 168, clock, [signal])!;
  assert.equal(brief.headline, "News coverage of protests in Lima, Peru rose sharply in the last 6 hours.");
  assert.deepEqual(brief.statements, [{ text: brief.headline, incident_ids: [], signal_ids: ["gdelt:-1"] }]);
  assert.deepEqual(brief.signals, [{ signal_id: "gdelt:-1", headline: brief.headline }]);
  assert.deepEqual(brief.references, []);
  assert.equal(structuredBrief([], 168, clock, [{ ...signal, rising: false }]), null);
});

function fixtureServer() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  const prepare = (sql: string) => {
    let values: SQLInputValue[] = [];
    return {
      bind(...next: SQLInputValue[]) {
        values = next;
        return this;
      },
      async all() {
        return { results: db.prepare(sql).all(...values) };
      },
      async run() {
        return db.prepare(sql).run(...values);
      },
    };
  };
  const env = {
    DB: {
      prepare,
      async batch(statements: { run(): Promise<unknown> }[]) {
        db.exec("BEGIN");
        try {
          const out = [];
          for (const statement of statements) out.push(await statement.run());
          db.exec("COMMIT");
          return out;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    ASSETS: { fetch: async () => new Response("fixture") },
    EUROPE_WATCH_OWNER_TOKEN: "fixture-owner",
    EUROPE_WATCH_COLLECTOR_TOKEN: "fixture-collector",
    EUROPE_WATCH_WORKER_TOKEN: "fixture-worker",
  } as unknown as Env;
  return {
    db,
    async api(path: string, body?: unknown, token = "fixture-owner") {
      const response = await server.fetch(
        new Request("https://fixture.invalid" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
      return { status: response.status, body: (await response.json()) as any };
    },
  };
}
const fileAt = (minutesAgo: number) =>
  new Date(Math.floor((Date.now() - minutesAgo * 60000) / 900000) * 900000).toISOString();

test("ingest counts each GDELT file once, stores no article text and serves place signals with their links", async () => {
  const s = fixtureServer();
  try {
    const register = (sources: unknown[]) => s.api("/api/sources", { sources }, "fixture-collector");
    assert.equal((await register([englishSource, translatedSource])).status, 200);
    const at = fileAt(0);
    const { batch } = await gkgBatch(englishSource.id, at, zip("e.csv", english));
    const paris = batch.places.find((p) => p.id === "-1456928")!;
    (paris.articles[0] as any).body = "Full article text that must never be stored.";
    const first = await s.api("/api/news/ingest", batch, "fixture-collector");
    assert.deepEqual(first.body, { duplicate: false, places: batch.places.length });
    const again = await s.api("/api/news/ingest", batch, "fixture-collector");
    assert.deepEqual(again.body, { duplicate: true, places: 0 });
    const translatedBatch = (await gkgBatch(translatedSource.id, at, zip("t.csv", translated))).batch;
    assert.equal((await s.api("/api/news/ingest", translatedBatch, "fixture-collector")).status, 200);
    const stored = s.db.prepare("SELECT articles,hours FROM news_places WHERE id='-1456928'").get() as any;
    assert.doesNotMatch(stored.articles, /Full article text/);
    for (const a of JSON.parse(stored.articles)) assert.deepEqual(Object.keys(a).sort(), ARTICLE_KEYS);
    const translatedParis = translatedBatch.places.find((p) => p.id === "-1456928")!.articles,
      headlines = (articles: NewsArticle[]) => new Set(articles.map(storyKey)).size;
    // The wsls.com and newsday.com copies of one AP story count as one headline.
    assert.equal(headlines(paris.articles), paris.articles.length - 1);
    assert.deepEqual(JSON.parse(stored.hours), {
      [englishSource.id]: { [at.slice(0, 13)]: headlines(paris.articles) },
      [translatedSource.id]: { [at.slice(0, 13)]: headlines(translatedParis) },
    });
    // A later file listing the same headlines adds no count.
    assert.equal((await s.api("/api/news/ingest", { ...batch, file_at: fileAt(15) }, "fixture-collector")).status, 200);
    assert.equal(
      (s.db.prepare("SELECT hours FROM news_places WHERE id='-1456928'").get() as any).hours,
      stored.hours,
    );
    const catalog = (await s.api("/api/news-signals")).body;
    assert.equal(catalog.coverage.window_files, 3);
    assert.equal(catalog.coverage.baseline_files, 0);
    assert.match(catalog.attribution, /The GDELT Project/);
    const signal = catalog.signals.find((x: NewsSignal) => x.id === "gdelt:-1456928");
    assert.equal(signal.articles_count, paris.articles.length + translatedParis.length);
    assert.equal(signal.stories_count, headlines(paris.articles) + headlines(translatedParis));
    assert.ok(signal.sources_count >= 8);
    assert.equal(signal.baseline, null);
    assert.equal(signal.rising, false);
    assert.ok(signal.articles.every((a: NewsArticle) => /^https?:\/\//.test(a.url)));
    assert.ok(signal.articles.some((a: NewsArticle) => a.language === "spa"));
    assert.ok(catalog.signals.every((x: NewsSignal) => x.sources_count >= 2));
    assert.deepEqual(
      (await s.api("/api/news-signals?bbox=100,-50,160,0")).body.signals.map((x: NewsSignal) => x.id),
      [],
    );
    // Revoking display hides every signal; revoking storage refuses new files.
    await register([{ ...englishSource, rights: { ...englishSource.rights, display: false } }]);
    assert.deepEqual((await s.api("/api/news-signals")).body.signals, []);
    await register([{ ...englishSource, rights: { ...englishSource.rights, storage: false } }]);
    const refused = await s.api("/api/news/ingest", { ...batch, file_at: fileAt(30) }, "fixture-collector");
    assert.deepEqual([refused.status, refused.body.error], [400, "source_storage_not_permitted"]);
    assert.equal((s.db.prepare("SELECT count(*) AS n FROM news_files").get() as any).n, 3);
  } finally {
    s.db.close();
  }
});

test("the collector reads the newest fetchable GDELT files, keeps listed files that 404 eligible and skips an unchanged listing", async () => {
  const requested: string[] = [],
    ingested: any[] = [],
    health: FetchState[] = [];
  const base = "https://data.gdeltproject.org/gdeltv2/",
    // The listing names 00:00, but as on 23 October the newest files are not fetchable yet.
    served = ["20261022233000", "20261022231500", "20261022230000"];
  const run = (checkpoint: FetchState, listingStatus = 200) =>
    collectSources(
      { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "isolated-fixture" },
      {
        sources: [englishSource],
        register: async () => {},
        checkpoint: async () => checkpoint,
        recordHealth: async (_, h) => {
          health.push(h.checkpoint);
        },
        fetch: async (input, init) => {
          const url = String(input);
          requested.push(url.replace(base, ""));
          if (url === "https://isolated.invalid/api/news/ingest") {
            ingested.push(JSON.parse(String(init?.body)));
            return Response.json({ duplicate: false });
          }
          if (url === englishSource.url)
            return listingStatus === 304
              ? new Response(null, { status: 304 })
              : new Response(listing, { headers: { "content-type": "text/plain", etag: '"listing"' } });
          const stamp = served.find((s) => url === base + s + ".gkg.csv.zip");
          if (stamp)
            return new Response(zip(stamp + ".gkg.csv", english), { headers: { "content-type": "application/zip" } });
          return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
        },
        now: () => Date.parse("2026-10-23T00:05:00Z"),
      },
    );
  const [first] = await run({});
  assert.equal(first.status, "ok");
  assert.deepEqual(requested, [
    "lastupdate.txt",
    "20261023000000.gkg.csv.zip",
    "20261022234500.gkg.csv.zip",
    "20261022233000.gkg.csv.zip",
    "https://isolated.invalid/api/news/ingest",
    "20261022231500.gkg.csv.zip",
    "https://isolated.invalid/api/news/ingest",
  ]);
  assert.deepEqual(
    ingested.map((b) => b.file_at),
    ["2026-10-22T23:30:00.000Z", "2026-10-22T23:15:00.000Z"],
  );
  assert.equal(first.received, ingested.reduce((n, b) => n + b.places.reduce((m: number, p: any) => m + p.articles.length, 0), 0));
  assert.deepEqual(health[0].news_files, ["20261022233000", "20261022231500"]);
  assert.equal(health[0].etag, '"listing"');
  // The two newest stay eligible and are tried again; the run takes the next fetchable file.
  requested.length = 0;
  const [second] = await run({ ...health[0], last_success_at: undefined });
  assert.equal(second.status, "ok");
  assert.deepEqual(requested.slice(1, 4), [
    "20261023000000.gkg.csv.zip",
    "20261022234500.gkg.csv.zip",
    "20261022230000.gkg.csv.zip",
  ]);
  assert.deepEqual(health.at(-1)!.news_files, served);
  // When nothing pending can be fetched, the run fails visibly and backs off.
  const [missing] = await run({ news_files: served });
  assert.deepEqual([missing.status, missing.error], ["error", "gdelt_files_unavailable"]);
  requested.length = 0;
  const [unchanged] = await run({ ...health[0], last_success_at: undefined }, 304);
  assert.equal(unchanged.status, "not_modified");
  assert.deepEqual(requested, ["lastupdate.txt"]);
  assert.equal(ingested.length, 3);
});

test("news signal copy exists in both interface languages", () => {
  for (const label of Object.values(NEWS_LABELS)) assert.notEqual(translate("it", label), label);
  for (const text of [
    "News signals",
    "News signal",
    "Rising news signal",
    "No baseline yet",
    "{ratio}× its usual coverage",
    "{articles} articles from {sources} sources",
    "{articles} articles from at least {sources} sources",
    "Machine-geocoded mentions in news coverage from GDELT, not a verified event. GDELT's place, theme and translation tagging is automatic and is often wrong, and syndicated copies of one story count once per outlet.",
    "Not queued for analysis. World Watch keeps only links, headlines and GDELT metadata, and publisher rights for model use of these articles are not established.",
    "Built from issuer fields and GDELT news coverage counts, no model",
  ]) {
    const italian = translate("it", text);
    assert.notEqual(italian, text);
    for (const placeholder of text.match(/\{\w+\}/g) ?? []) assert.ok(italian.includes(placeholder), placeholder);
  }
});

test(
  "the news filter lists signals as their own category and opens one with its article links",
  { timeout: 60000 },
  async () => {
    const vite = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5201", "--strictPort"],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:5201")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      const clock = Date.parse("2026-10-23T10:20:00Z");
      const signal = rankSignal(
        {
          id: "-1",
          place,
          hours: { [englishSource.id]: { "2026-10-23T09": 30 } },
          articles: Array.from({ length: 30 }, (_, i) => article(i, { seen_at: "2026-10-23T09:00:00.000Z" })),
        },
        week(clock),
        clock,
      )!;
      const reads: string[] = [];
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.addInitScript({ content: `window.EventSource=class{constructor(){}addEventListener(){}close(){}};` });
      await page.route("**/*", async (route: any) => {
        const u = new URL(route.request().url());
        if (u.pathname === "/src/client/Map.tsx")
          return route.fulfill({
            contentType: "text/javascript",
            body: `export const colors={informational:'#69c',minor:'#fc6',significant:'#fa6',severe:'#f77',critical:'#f44',unknown:'#aaa'};export default function Map(p){window.__newsOnMap=p.newsSignals.length;return null}`,
          });
        if (u.pathname === "/api/brief") return route.fulfill({ json: { current: null, pending: false } });
        if (u.pathname === "/api/snapshot")
          return route.fulfill({ json: { incidents: [], incoming: [], sources: [], status: {}, cursor: "1" } });
        if (u.pathname === "/api/news-signals") {
          reads.push(u.pathname);
          return route.fulfill({
            json: {
              signals: [signal],
              coverage: { window_hours: 6, window_files: 48, baseline_files: 1344, first_file_at: null, last_file_at: null },
              attribution: "The GDELT Project (https://www.gdeltproject.org/).",
              license_url: "https://www.gdeltproject.org/about.html#termsofuse",
            },
          });
        }
        if (u.pathname.startsWith("/api/")) throw Error("Unexpected API fixture " + u.pathname);
        if (u.hostname !== "127.0.0.1") return route.abort();
        return route.continue();
      });
      await page.goto("http://127.0.0.1:5201");
      await page.getByRole("button", { name: "Hazards", exact: true }).waitFor();
      assert.deepEqual(reads, [], "no news read before the filter is chosen");
      await page.getByRole("button", { name: "News signals", exact: true }).click();
      const row = page.locator('[data-signal-id="gdelt:-1"]');
      await row.waitFor();
      assert.deepEqual(reads, ["/api/news-signals"]);
      assert.equal(await page.evaluate(() => (window as any).__newsOnMap), 1);
      const text = (await row.textContent()) ?? "";
      assert.match(text, /Lima, Lima, Peru/);
      assert.match(text, /Rising news signal/);
      assert.match(text, /30 distinct headlines · 30 articles from 12 sources/);
      await page.getByText("Baseline from 1,344 earlier GDELT files.", { exact: false }).waitFor();
      await row.click();
      await page.getByRole("heading", { name: "Lima, Lima, Peru", level: 1 }).waitFor();
      await page.getByText("not a verified event", { exact: false }).waitFor();
      const links = await page.locator(".news-panel a.camera-row").evaluateAll((as: HTMLAnchorElement[]) =>
        as.map((a) => [a.href, a.target, a.rel]),
      );
      assert.equal(links.length, 20);
      assert.deepEqual(links[0], ["https://news0.example/story/0", "_blank", "noreferrer"]);
      await page.getByText("Not queued for analysis.", { exact: false }).waitFor();
    } finally {
      if (browser) await browser.close();
      vite.kill("SIGTERM");
    }
  },
);
