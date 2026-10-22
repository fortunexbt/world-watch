#!/usr/bin/env node
/**
 * Rebuilds eval/severity/dataset.json from public sources.
 *
 * Ground truth: USGS ComCat PAGER alert level (public domain). Text: Wikipedia
 * lead excerpts (CC BY-SA 4.0) of the earthquake's article in every language the
 * severity lexicons cover. Events are linked through Wikidata property P3196
 * (USGS earthquake ID, CC0). Every request is pinned by revision id in the output,
 * so the evaluation itself (run.ts) is offline and deterministic.
 *
 * This is a one-off dataset build, not the collector. Run it only to refresh the
 * dataset:  node scripts/severity-eval/build-dataset.mjs [cache-dir]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = new URL("../../eval/severity/dataset.json", import.meta.url);
const CACHE = process.argv[2] ?? "/tmp/world-watch-severity-eval-cache";
const UA = "world-watch-severity-eval/1.0 (https://github.com/fortunexbt/world-watch)";
/** Wikipedia language editions that map onto a lexicon table (id and ms share one). */
const LANGS = [
  "en", "fr", "es", "pt", "it", "de", "nl", "ru", "uk", "ar", "fa", "ur", "hi",
  "bn", "tr", "id", "ms", "sw", "zh", "ja", "ko", "th", "vi",
];
const EXCERPT_CHARS = 900;

await mkdir(CACHE, { recursive: true });

async function getJson(key, url, init) {
  const file = join(CACHE, `${key}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {}
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...init?.headers } });
    if (res.status === 404 || res.status === 400) return null;
    if (res.ok) {
      const body = await res.json();
      await writeFile(file, JSON.stringify(body));
      return body;
    }
    await new Promise((r) => setTimeout(r, res.status === 429 ? 60000 : 1500 * (attempt + 1)));
  }
  throw Error(`failed ${url}`);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const sparql = await getJson(
  "wikidata-p3196",
  "https://query.wikidata.org/sparql?query=" +
    encodeURIComponent("SELECT ?e ?id WHERE { ?e wdt:P3196 ?id . }"),
  { headers: { accept: "application/sparql-results+json" } },
);
const linked = sparql.results.bindings.map((b) => ({
  qid: b.e.value.split("/").pop(),
  usgsId: b.id.value,
}));
console.error(`wikidata items with a USGS id: ${linked.length}`);

/** One bulk query per alert level and decade, which stays far under USGS's rate limit. */
const pager = new Map();
for (const level of ["green", "yellow", "orange", "red"]) {
  for (let year = 1900; year <= new Date().getUTCFullYear(); year += 10) {
    const body = await getJson(
      `usgs-${level}-${year}`,
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&alertlevel=${level}&orderby=time-asc&limit=20000&starttime=${year}-01-01&endtime=${year + 10}-01-01`,
    );
    for (const f of body?.features ?? []) pager.set(f.id, f.properties);
  }
}
const withAlert = linked.flatMap((item) => {
  const p = pager.get(item.usgsId);
  return p?.alert
    ? [{
        ...item,
        alert: p.alert,
        magnitude: p.mag,
        place: p.place,
        time: new Date(p.time).toISOString(),
        usgsUrl: p.url,
      }]
    : [];
});
console.error(`with a PAGER alert: ${withAlert.length}`);

const sitelinks = new Map();
for (let i = 0; i < withAlert.length; i += 50) {
  const batch = withAlert.slice(i, i + 50);
  const body = await getJson(
    `wbget-${batch[0].qid}-${i}`,
    "https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&format=json&ids=" +
      batch.map((b) => b.qid).join("|"),
  );
  for (const [qid, entity] of Object.entries(body.entities))
    sitelinks.set(qid, entity.sitelinks ?? {});
}

const jobs = withAlert.flatMap((event) =>
  LANGS.flatMap((lang) => {
    const link = sitelinks.get(event.qid)?.[`${lang}wiki`];
    return link ? [{ event, lang, title: link.title }] : [];
  }),
);
console.error(`articles to fetch: ${jobs.length}`);

const docs = (
  await pool(jobs, 8, async ({ event, lang, title }) => {
    const body = await getJson(
      `wp-${lang}-${event.qid}`,
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts|revisions&exintro=1&explaintext=1&rvprop=ids&redirects=1&titles=${encodeURIComponent(title)}`,
    );
    const page = Object.values(body?.query?.pages ?? {})[0];
    const extract = page?.extract?.replace(/\s+/gu, " ").trim();
    const revid = page?.revisions?.[0]?.revid;
    if (!extract || !revid) return null;
    return {
      id: `${event.qid}:${lang}`,
      qid: event.qid,
      lang,
      title: page.title,
      revid,
      url: `https://${lang}.wikipedia.org/w/index.php?oldid=${revid}`,
      text: truncate(extract),
    };
  })
).filter(Boolean);

/** Cut at the last sentence end inside the budget, so no sentence is split mid-clause. */
function truncate(text) {
  if (text.length <= EXCERPT_CHARS) return text;
  const head = text.slice(0, EXCERPT_CHARS);
  const cut = Math.max(...[".", "!", "?", "。", "؟", "।", "۔"].map((c) => head.lastIndexOf(c)));
  return cut > EXCERPT_CHARS / 3 ? head.slice(0, cut + 1) : head;
}

const kept = new Set(docs.map((d) => d.qid));
const events = withAlert
  .filter((e) => kept.has(e.qid))
  .sort((a, b) => a.time.localeCompare(b.time))
  .map(({ qid, usgsId, alert, magnitude, place, time, usgsUrl }) => ({
    qid, usgsId, alert, magnitude, place, time, usgsUrl,
  }));
docs.sort((a, b) => a.id.localeCompare(b.id));

await writeFile(
  OUT,
  JSON.stringify(
    {
      built_from: ["wikidata P3196", "USGS ComCat eventid query", "Wikipedia extracts by revision"],
      retrieved: new Date().toISOString().slice(0, 10),
      excerpt_chars: EXCERPT_CHARS,
      licences: {
        labels: "USGS ComCat PAGER alert levels, public domain",
        text: "Wikipedia lead extracts, CC BY-SA 4.0, attributed per document by title, language and revision url",
        links: "Wikidata P3196, CC0",
      },
      events,
      documents: docs,
    },
    null,
    1,
  ) + "\n",
);
console.error(`events ${events.length}, documents ${docs.length}`);
