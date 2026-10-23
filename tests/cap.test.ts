import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  CAP_IMPACT,
  capIndex,
  circleRing,
  parseCap,
  readCap,
} from "../src/collector/adapters/cap.js";
import { collectSources } from "../src/collector/index.js";
import type { FetchState } from "../src/collector/fetch.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { PUBLIC_SOURCES } from "../src/public/snapshot.js";
import server from "../src/server/index.js";
import { structuredBrief } from "../src/server/structured-brief.js";
import { sourceCoverage } from "../src/shared/coverage.js";
import type {
  IncidentView,
  ObservationInput,
  SourceRecord,
} from "../src/shared/contracts.js";
import {
  COLLECTOR,
  env,
  migrate,
  OWNER,
  sqliteD1,
} from "../scripts/synthetic.js";

// Real responses of 23 October 2026, trimmed to a few index entries with their CAP documents kept
// whole. PAGASA's are one province chain of flood advisories, from first alert through two updates,
// a mistaken issue, its cancellation, the reissue and one more update, plus a multi-province advisory and a tropical
// cyclone wind signal warning. INMET's are three warnings, an update and a cancellation whose
// warning the feed no longer lists. The DWD message is one update in eight languages. Sources:
// PAGASA-DOST (CC BY 4.0); Instituto Nacional de Meteorologia (INMET); Deutscher Wetterdienst
// (CC BY 4.0), boundaries © GeoBasis-DE / BKG 2021 (Daten modifiziert).
const fixture = (name: string) =>
  JSON.parse(readFileSync("tests/fixtures/" + name, "utf8")) as {
    index: string;
    documents: Record<string, string>;
  };
const pagasa = fixture("pagasa-cap.json"),
  inmet = fixture("inmet-cap.json");
const dwd = readFileSync("tests/fixtures/dwd-cap-multilingual.xml", "utf8");
const source = (id: string) => sourceRegistry.find((s) => s.id === id)!;
const pagasaSource = source("ph-pagasa-warnings"),
  inmetSource = source("br-inmet-warnings");
const record = (o: ObservationInput) => JSON.parse(o.excerpts[0].text);

/** Every observation a complete read of a fixture gives, in the index's order. */
function parseAll(s: SourceRecord, f: ReturnType<typeof fixture>) {
  return capIndex(s, f.index).flatMap((e) =>
    parseCap(s, readCap(f.documents[new URL(e.url).pathname]), e.url),
  );
}
/** A CAP document around one info block, for shapes the fixtures lack. */
const cap = (
  info: string,
  head = "<status>Actual</status><msgType>Alert</msgType><scope>Public</scope>",
) =>
  `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>fixture-1</identifier><sender>fixture</sender><sent>2026-10-23T12:00:00+00:00</sent>${head}<info><category>Met</category><event>Strong wind</event><urgency>Expected</urgency><severity>Severe</severity><certainty>Likely</certainty><headline>Wind warning</headline>${info}</info></alert>`;

test("the CAP index gives each document on the issuer's own host and rejects unexpected paths", () => {
  const entries = capIndex(pagasaSource, pagasa.index);
  assert.equal(entries.length, 9);
  assert(
    entries.every((e) =>
      e.url.startsWith("https://publicalert.pagasa.dost.gov.ph/output/"),
    ),
  );
  // PAGASA linked GFA #3 through a bare IP address whose certificate names its host.
  assert(pagasa.index.includes("https://121.58.193.10/output/gfa/f76a4287"));
  assert(
    entries.some((e) =>
      e.url.endsWith("/gfa/f76a4287-260f-4215-9443-a19ea2494c55.cap"),
    ),
  );
  assert.equal(entries[0].stamp, "2026-10-23T22:42:25+08:00");
  const rss = capIndex(inmetSource, inmet.index);
  assert.deepEqual(
    rss.map((e) => e.url),
    ["56168", "56156", "56126", "56104", "56075"].map(
      (id) => "https://apiprevmet3.inmet.gov.br/avisos/rss/" + id,
    ),
  );
  assert.throws(
    () =>
      capIndex(
        inmetSource,
        inmet.index.replace("/avisos/rss/56168<", "/avisos/other/56168<"),
      ),
    /unexpected_cap_document_path/,
  );
  assert.throws(
    () => capIndex(inmetSource, "<html/>"),
    /unsupported_cap_index/,
  );
});

test("PAGASA flood advisories map their province polygons; wind signal warnings named by code are kept unmapped", () => {
  const rows = parseAll(pagasaSource, pagasa);
  assert.equal(rows.length, 9);
  const visayas = rows.find(
    (r) => r.native_id === "2865b5a9-3636-4924-898d-cb640811031f",
  )!;
  assert.equal(visayas.title, "General Flood Advisory");
  // PAGASA states no language, so CAP's default applies.
  assert.equal(visayas.original_language, "en-US");
  assert.equal(visayas.official?.activity, "flood");
  assert.equal(visayas.official?.impact, "minor");
  assert.equal(visayas.official?.expires_at, "2026-10-23T21:45:37.000Z");
  assert.equal(visayas.source_geo?.accuracy, "area");
  assert.match(
    visayas.source_geo!.name,
    /^Eastern Samar; Northern Samar; Southern Leyte; Leyte; Biliran; Samar$/,
  );
  // CAP writes latitude first; the centre lands in the Eastern Visayas.
  assert(visayas.source_geo!.lon > 124 && visayas.source_geo!.lon < 126);
  assert(visayas.source_geo!.lat > 10 && visayas.source_geo!.lat < 13);
  assert.equal(visayas.footprint?.role, "advisory_area");
  assert.equal(visayas.footprint?.detail?.parts.length, 6);
  assert.equal(visayas.footprint?.detail?.parts[0].label, "Eastern Samar");
  assert.equal(visayas.footprint?.source_url, visayas.canonical_url);
  const fields = record(visayas);
  assert.equal(fields.issuer, "PAGASA");
  assert.equal(fields.sender_name, "PAGASA-DOST");
  assert.deepEqual(fields.unmapped_areas, []);
  assert.match(fields.description, /^Under present weather conditions/);
  // Character references in the issuer's text are resolved, and its line breaks kept.
  assert(!/&#x?[0-9a-f]+;/i.test(visayas.excerpts[0].text));
  const signal = rows.find(
    (r) => r.native_id === "a48da0d2-bee0-4c9f-a68b-e8709ff4b0a5",
  )!;
  assert.equal(signal.official?.activity, "tropical_cyclone");
  assert.equal(signal.official?.impact, "informational");
  assert.equal(signal.source_geo, undefined);
  assert.equal(signal.footprint, undefined);
  assert.deepEqual(record(signal).unmapped_areas, ["Batanes"]);
  assert.deepEqual(record(signal).geocodes, ["SAME 020900000"]);
  // Each message keeps its own ID; a chain names the earliest message it references.
  const reissue = rows.find(
    (r) => r.native_id === "855536fb-a3b5-4721-9015-92cc1dd493dc",
  )!;
  assert.equal(reissue.official?.message_type, "Update");
  assert.deepEqual(reissue.official?.references, [
    "f76a4287-260f-4215-9443-a19ea2494c55",
  ]);
  assert.equal(reissue.source_event_id, "f76a4287-260f-4215-9443-a19ea2494c55");
  const cancel = rows.find((r) => r.official?.message_type === "Cancel")!;
  assert.equal(cancel.official?.cancelled, true);
  assert.deepEqual(cancel.official?.references, [
    "fef26327-8053-41e5-a433-8e24347d148f",
  ]);
  assert(
    rows
      .filter((r) => r.official?.message_type !== "Cancel")
      .every((r) => !r.official?.cancelled),
  );
});

test("INMET warnings keep Portuguese text unchanged, map Extreme to severe and name the long parameters they leave out", () => {
  const rows = parseAll(inmetSource, inmet);
  assert.equal(rows.length, 5);
  const storm = rows.find((r) => r.canonical_url.endsWith("/56168"))!;
  assert.equal(storm.native_id, "urn:oid:2.49.0.0.76.0.2026.28553.1");
  assert.equal(storm.original_language, "pt-BR");
  assert.equal(storm.title, "Aviso de Tempestade. Severidade Grau: Extreme");
  assert.equal(storm.official?.impact, "severe");
  assert.equal(storm.official?.activity, "severe_weather");
  assert.equal(storm.official?.issuer, "Instituto Nacional de Meteorologia");
  assert.equal(storm.official?.effective_at, "2026-10-24T09:00:00.000Z");
  assert.equal(storm.official?.expires_at, "2026-10-25T00:00:00.000Z");
  const raw = inmet.documents["/avisos/rss/56168"];
  const description = /<description>([^<]*)<\/description>/.exec(raw)![1];
  assert.equal(record(storm).description, description);
  assert.deepEqual(record(storm).parameters_not_kept, ["Municipios"]);
  assert(record(storm).parameters.includes("ColorRisk: #F80703"));
  assert.equal(record(storm).headline_en, null);
  assert(rows.every((r) => r.excerpts[0].text.length < 20000));
  assert(
    rows.every((r) => r.source_geo && r.footprint?.role === "advisory_area"),
  );
  // Brazil, not wherever a swapped latitude and longitude would put it.
  assert(rows.every((r) => r.source_geo!.lon < -34 && r.source_geo!.lat < 6));
  const cancel = rows.find((r) => r.official?.message_type === "Cancel")!;
  assert.equal(cancel.official?.cancelled, true);
  assert.equal(cancel.official?.references?.length, 1);
  // Rain is not flooding, and no INMET event names a cyclone.
  assert(rows.every((r) => r.official?.activity === "severe_weather"));
});

test("multilingual CAP keeps the issuer's language block and its English block beside it", () => {
  const alert = readCap(dwd);
  assert.deepEqual(
    alert.infos.map((i) => i.language),
    ["de-DE", "en", "fr", "es", "ar", "ru", "tr", "pl"],
  );
  const as = (languages: string[]) =>
    parseCap(
      { ...pagasaSource, languages },
      alert,
      "https://www.dwd.de/fixture",
    )[0];
  const german = as(["de"]);
  assert.equal(german.original_language, "de-DE");
  assert.equal(german.title, alert.infos[0].headline);
  assert.equal(record(german).event, alert.infos[0].event);
  assert.equal(record(german).headline_en, alert.infos[1].headline);
  assert.equal(record(german).description_en, alert.infos[1].description);
  const french = as(["fr"]);
  assert.equal(french.original_language, "fr");
  assert.equal(record(french).headline_en, alert.infos[1].headline);
  const english = as(["en"]);
  assert.equal(english.original_language, "en");
  assert.equal(record(english).headline_en, null);
  // No block in the source's language: the first block's language stands.
  assert.equal(as(["ja"]).original_language, "de-DE");
  // Every language block repeats the areas; only the chosen one's are mapped.
  assert.equal(
    german.footprint?.detail?.parts.length,
    alert.infos[0].areas.reduce((n, a) => n + a.polygons.length, 0),
  );
  assert.deepEqual(
    german.official?.references,
    alert.references.map((r) => r.identifier),
  );
});

test("CAP circles become enclosing polygons, invalid shapes are dropped and namespace prefixes read alike", () => {
  const circled = readCap(
    cap(
      "<area><areaDesc>Harbour</areaDesc><circle>-17.8,178.9 30</circle></area>",
    ),
  );
  const ring = circleRing(circled.infos[0].areas[0].circles[0]);
  assert.equal(ring.length, 65);
  assert.deepEqual(ring[0], ring[64]);
  const km = ([lon, lat]: number[]) => {
    const p = Math.PI / 180,
      a =
        Math.sin(((lat + 17.8) * p) / 2) ** 2 +
        Math.cos(-17.8 * p) *
          Math.cos(lat * p) *
          Math.sin(((lon - 178.9) * p) / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
  };
  // Vertices sit just outside the circle, so its edges never cut into it.
  for (const p of ring.slice(0, -1)) {
    assert(km(p) >= 30 / Math.cos(Math.PI / 64) - 1e-6);
    assert(km(p) <= 30 / Math.cos(Math.PI / 64) + 1e-6);
  }
  const [row] = parseCap(pagasaSource, circled, "https://example.invalid/c");
  assert.equal(row.official?.activity, "severe_weather");
  assert.equal(row.official?.impact, "significant");
  assert(row.source_geo!.radius_km! >= 30);
  assert(Math.abs(row.source_geo!.lon - 178.9) < 0.01);
  assert.equal(row.footprint?.detail?.parts[0].label, "Harbour");
  // A circle across the 180° line stays one continuous ring.
  const dateline = parseCap(
    pagasaSource,
    readCap(
      cap(
        "<area><areaDesc>Taveuni</areaDesc><circle>-16.8,179.9 40</circle></area>",
      ),
    ),
    "https://example.invalid/d",
  )[0];
  assert(Math.abs(Math.abs(dateline.source_geo!.lon) - 179.9) < 0.01);
  assert(dateline.footprint);
  // An unclosed polygon, a three-number pair and a negative radius are not geometry.
  const broken = readCap(
    cap(
      "<area><areaDesc>A</areaDesc><polygon>1,1 1,2 2,2 2,1</polygon><polygon>1,1,0 1,2 2,2 1,1</polygon><circle>1,1 -3</circle><geocode><valueName>ZONE</valueName><value>A1</value></geocode></area>",
    ),
  );
  assert.deepEqual(broken.infos[0].areas[0].polygons, []);
  assert.deepEqual(broken.infos[0].areas[0].circles, []);
  assert.equal(
    parseCap(pagasaSource, broken, "https://example.invalid/b")[0].source_geo,
    undefined,
  );
  const prefixed = cap(
    "<area><areaDesc>A</areaDesc><polygon>1,1 1,2 2,2 1,1</polygon></area>",
  )
    .replace(/<(\/?)(\w+)/g, "<$1cap:$2")
    .replace("<cap:?xml", "<?xml")
    .replace('xmlns="', 'xmlns:cap="');
  assert.deepEqual(
    readCap(prefixed),
    readCap(
      cap(
        "<area><areaDesc>A</areaDesc><polygon>1,1 1,2 2,2 1,1</polygon></area>",
      ),
    ),
  );
  assert.throws(
    () => readCap("<alert><identifier>x</identifier></alert>"),
    /invalid_cap_alert/,
  );
});

test("only actual public alerts, updates and cancellations become observations, and severity never reaches critical", () => {
  const area =
    "<area><areaDesc>A</areaDesc><polygon>1,1 1,2 2,2 1,1</polygon></area>";
  for (const head of [
    "<status>Exercise</status><msgType>Alert</msgType><scope>Public</scope>",
    "<status>Test</status><msgType>Alert</msgType><scope>Public</scope>",
    "<status>Actual</status><msgType>Alert</msgType><scope>Restricted</scope>",
    "<status>Actual</status><msgType>Ack</msgType><scope>Public</scope>",
  ])
    assert.deepEqual(
      parseCap(
        pagasaSource,
        readCap(cap(area, head)),
        "https://example.invalid/x",
      ),
      [],
    );
  assert.deepEqual(Object.values(CAP_IMPACT), [
    "informational",
    "minor",
    "significant",
    "severe",
  ]);
  const event = (name: string, category = "Met") =>
    parseCap(
      pagasaSource,
      readCap(
        cap(area)
          .replace("<event>Strong wind</event>", `<event>${name}</event>`)
          .replace(
            "<category>Met</category>",
            `<category>${category}</category>`,
          ),
      ),
      "https://example.invalid/e",
    )[0].official?.activity;
  assert.equal(event("Typhoon"), "tropical_cyclone");
  assert.equal(event("Hurricane force winds"), "severe_weather");
  assert.equal(event("Storm surge"), "flood");
  assert.equal(event("Inundação"), "flood");
  assert.equal(event("Chuvas Intensas"), "severe_weather");
  assert.equal(event("Earthquake", "Geo"), "earthquake");
  assert.equal(event("Earthquake drill", "Safety"), "official_advisory");
  assert.equal(event("Tsunami", "Geo"), "official_advisory");
  assert.equal(event("Bushfire", "Fire"), "wildfire");
  assert.equal(event("Fire danger", "Fire"), "official_advisory");
});

/** An in-memory API that ingests whatever the collector sends it. */
function api() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const e = env(sqliteD1(db));
  return async (path: string, body?: unknown, token = COLLECTOR) => {
    const r = await server.fetch(
      new Request("https://fixture.invalid" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      e,
    );
    return { status: r.status, body: (await r.json()) as any };
  };
}
/** Serves a fixture's index at the source URL and each document at its path on the source's host, with the types both issuers sent. */
function upstream(
  s: SourceRecord,
  f: ReturnType<typeof fixture>,
  requests: string[] = [],
) {
  return (async (input: any) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.href === s.url)
      return new Response(f.index, {
        headers: {
          "content-type": f.index.includes("<feed")
            ? "application/atom+xml; charset=UTF-8"
            : "application/rss+xml",
        },
      });
    const doc = f.documents[url.pathname];
    return doc && url.origin === new URL(s.url).origin
      ? new Response(doc, { headers: { "content-type": "text/xml" } })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
// The fetch layer stamps its checkpoint with the wall clock, so each poll runs an hour after the last.
let clock = Date.now();
async function collect(
  call: ReturnType<typeof api>,
  s: SourceRecord,
  fetcher: typeof fetch,
  before: FetchState = {},
  maxRequests = 40,
) {
  let saved: FetchState = {};
  const [result] = await collectSources(
    { EW_API_URL: "https://fixture.invalid", EW_COLLECTOR_TOKEN: COLLECTOR },
    {
      sources: [s],
      register: async () => {},
      checkpoint: async () => before,
      recordHealth: async (_, h) => {
        saved = h.checkpoint;
      },
      ingest: async (rows) => {
        const r = await call("/api/ingest", { observations: rows });
        assert.equal(r.status, 200);
      },
      request: (path, payload) => call(path, payload).then((r) => r.body),
      fetch: fetcher,
      maxRequests,
      now: () => clock,
    },
  );
  clock += 3600000;
  return { result, saved };
}

test("a PAGASA chain stays one incident through updates, a cancelled mistaken issue and its reissue", async () => {
  const call = api();
  assert.equal(
    (await call("/api/sources", { sources: [pagasaSource] })).status,
    200,
  );
  const { result, saved } = await collect(
    call,
    pagasaSource,
    upstream(pagasaSource, pagasa),
  );
  assert.deepEqual(
    [result.status, result.received, result.error],
    ["ok", 9, undefined],
  );
  const snapshot: IncidentView[] = (
    await call("/api/snapshot", undefined, OWNER)
  ).body.incidents;
  // The wind signal warning names its province only by code, so it is not published.
  assert.deepEqual(snapshot.map((i) => i.headline).sort(), [
    "General Flood Advisory",
    "General Flood Advisory",
  ]);
  const chain = snapshot.find((i) => i.location?.name === "Cagayan; Batanes")!;
  // Seven messages, from the first alert (three provinces) to the last update (two), are one warning.
  assert.equal(chain.version, 7);
  assert.equal(chain.cancelled, false);
  assert.equal(
    chain.reports[0].canonical_url,
    "https://publicalert.pagasa.dost.gov.ph/output/gfa/a53f2598-479a-40b1-b1a3-89561dc43dd4.cap",
  );
  assert.equal(chain.location?.country, "PH");
  assert.equal(chain.activity, "flood");
  assert.equal(chain.evidence_status, "official_advisory");
  assert.equal(chain.footprint?.role, "advisory_area");
  assert.equal(Object.keys(saved.cap_documents ?? {}).length, 9);
  assert.equal(Object.keys(saved.accepted_items ?? {}).length, 9);
});

test("a PAGASA cancellation ends the warning it names when no reissue follows", async () => {
  const call = api();
  await call("/api/sources", { sources: [pagasaSource] });
  const cut = structuredClone(pagasa);
  cut.index = cut.index.replace(
    /<entry>(?:(?!<entry>)[\s\S])*?(?:855536fb|a53f2598)[\s\S]*?<\/entry>\s*/g,
    "",
  );
  await collect(call, pagasaSource, upstream(pagasaSource, cut));
  const chain = (
    (await call("/api/snapshot", undefined, OWNER)).body
      .incidents as IncidentView[]
  ).find((i) => i.location?.name === "Cagayan; Batanes")!;
  assert.equal(chain.cancelled, true);
  assert.equal(chain.version, 5);
  // The reissue arrives on the next poll; replay shows each state as it was known.
  await new Promise((done) => setTimeout(done, 5));
  const between = new Date().toISOString();
  await new Promise((done) => setTimeout(done, 5));
  const { saved } = await collect(
    call,
    pagasaSource,
    upstream(pagasaSource, pagasa),
  );
  assert.equal(Object.keys(saved.cap_documents ?? {}).length, 9);
  const chainAt = async (query: string) =>
    (
      (await call("/api/snapshot?hours=0" + query, undefined, OWNER)).body
        .incidents as IncidentView[]
    ).find((i) => i.id === chain.id)!;
  const then = await chainAt("&at=" + between);
  assert.deepEqual([then.version, then.cancelled], [5, true]);
  const now = await chainAt("");
  assert.deepEqual([now.version, now.cancelled], [7, false]);
});

test("INMET cancellations of warnings never read publish nothing; one of a read warning cancels it", async () => {
  const call = api();
  await call("/api/sources", { sources: [inmetSource] });
  await collect(call, inmetSource, upstream(inmetSource, inmet));
  let snapshot: IncidentView[] = (await call("/api/snapshot", undefined, OWNER))
    .body.incidents;
  assert.equal(snapshot.length, 4);
  assert(snapshot.every((i) => !i.cancelled && i.location?.country === "BR"));
  const storm = snapshot.find((i) => i.impact === "severe")!;
  // The same warning cancelled, as INMET writes cancellations.
  const raw = inmet.documents["/avisos/rss/56168"];
  const cancel = raw
    .replace(
      "<identifier>urn:oid:2.49.0.0.76.0.2026.28553.1</identifier>",
      "<identifier>urn:oid:2.49.0.0.76.0.2026.28553.2</identifier>",
    )
    .replace(
      "<msgType>Alert</msgType><scope>Public</scope>",
      "<msgType>Cancel</msgType><scope>Public</scope><references>info.aviso@inmet.gov.br,urn:oid:2.49.0.0.76.0.2026.28553.1,2026-10-23T13:55:45-03:00</references>",
    )
    .replace(
      "<sent>2026-10-23T13:55:45-03:00</sent>",
      "<sent>2026-10-23T15:00:00-03:00</sent>",
    );
  const next = structuredClone(inmet);
  next.documents["/avisos/rss/56200"] = cancel;
  next.index = next.index.replace(
    "<item>",
    "<item>\n<title>Cancel</title>\n<link>https://apiprevmet3.inmet.gov.br/avisos/rss/56200</link>\n<pubDate>Sat, 24 Oct 2026 06:00:00 +0000</pubDate>\n</item>\n<item>",
  );
  const { saved } = await collect(
    call,
    inmetSource,
    upstream(inmetSource, next),
  );
  snapshot = (await call("/api/snapshot", undefined, OWNER)).body.incidents;
  assert.equal(snapshot.length, 4);
  const ended = snapshot.find((i) => i.id === storm.id)!;
  assert.equal(ended.cancelled, true);
  assert.equal(ended.version, 2);
  assert.equal(Object.keys(saved.cap_documents ?? {}).length, 6);
});

test("unchanged CAP documents are not read again, and a short budget resumes on the next poll", async () => {
  const call = api();
  await call("/api/sources", { sources: [pagasaSource] });
  const requests: string[] = [];
  // 16 operations leave room for the index, one batch of four reads and their two ingest calls.
  const first = await collect(
    call,
    pagasaSource,
    upstream(pagasaSource, pagasa, requests),
    {},
    16,
  );
  assert.equal(first.result.status, "ok");
  assert.equal(requests.length, 5);
  assert.equal(Object.keys(first.saved.cap_documents ?? {}).length, 4);
  requests.length = 0;
  const second = await collect(
    call,
    pagasaSource,
    upstream(pagasaSource, pagasa, requests),
    first.saved,
  );
  assert.equal(requests.length, 6);
  assert(
    !requests
      .slice(1)
      .some((u) => Object.keys(first.saved.cap_documents!).includes(u)),
  );
  assert.equal(Object.keys(second.saved.cap_documents ?? {}).length, 9);
  // Listed documents read on earlier polls still count as the source's records.
  assert.equal(Object.keys(second.saved.accepted_items ?? {}).length, 9);
  assert.equal(
    sourceCoverage(
      pagasaSource,
      {
        checked_at: "2026-10-23T16:00:00Z",
        last_success_at: "2026-10-23T16:00:00Z",
        error: null,
        checkpoint: second.saved,
      },
      Date.parse("2026-10-23T16:01:00Z"),
    ).records,
    9,
  );
  // Each CAP source is judged on the collector's five-minute cadence like every other source.
  const health = (at: string, error: string | null = null) => ({
    checked_at: at,
    last_success_at: error ? "2026-10-23T15:00:00Z" : at,
    error,
    checkpoint: second.saved,
  });
  const status = (s: SourceRecord, h: ReturnType<typeof health>) =>
    sourceCoverage(s, h, Date.parse("2026-10-23T16:01:00Z")).status;
  for (const s of [pagasaSource, inmetSource]) {
    assert.equal(status(s, health("2026-10-23T16:00:00Z")), "observed");
    assert.equal(status(s, health("2026-10-23T15:50:00Z")), "stale");
    assert.equal(
      status(s, health("2026-10-23T16:00:00Z", "unexpected_cap_document_path")),
      "failing",
    );
  }
  requests.length = 0;
  const changed = structuredClone(pagasa);
  changed.index = changed.index.replace(
    "<updated>2026-10-23T17:45:37+08:00</updated>",
    "<updated>2026-10-23T18:00:00+08:00</updated>",
  );
  const third = await collect(
    call,
    pagasaSource,
    upstream(pagasaSource, changed, requests),
    second.saved,
  );
  assert.equal(third.result.status, "ok");
  assert.equal(requests.length, 2);
});

test("national CAP sources carry their stated terms, publish in the demo and feeds, and MeteoAlarm stays out", () => {
  for (const s of [pagasaSource, inmetSource]) {
    assert.equal(s.status, "enabled");
    assert.equal(s.family, "cap");
    assert.equal(s.config.operational_role, "structured_natural_hazard");
    assert.deepEqual(
      [
        s.rights.access,
        s.rights.storage,
        s.rights.display,
        s.rights.redistribute,
        s.rights.ai,
      ],
      [true, true, true, true, false],
    );
    assert(PUBLIC_SOURCES.includes(s));
  }
  assert.match(pagasaSource.rights.basis, /Licensed under CC BY 4\.0/);
  assert.match(
    inmetSource.rights.basis,
    /podera ser reproduzido desde que citada a fonte/,
  );
  assert.match(
    inmetSource.rights.attribution,
    /^Fonte: Instituto Nacional de Meteorologia/,
  );
  const meteo = sourceRegistry.filter((s) => s.id.startsWith("meteoalarm-"));
  assert.equal(meteo.length, 38);
  for (const s of meteo) {
    assert.equal(s.status, "license_required");
    assert.equal(s.rights.display, false);
    assert.match(s.rights.basis, /never longer than ten minutes/);
    assert.equal(sourceCoverage(s, null).status, "access_unresolved");
    assert.match(sourceCoverage(s, null).unresolved!, /ten-minute ceiling/);
    assert(!PUBLIC_SOURCES.includes(s));
  }
});

test("the structured brief counts national CAP warnings by issuer, hazard and country", async () => {
  const call = api();
  await call("/api/sources", { sources: [pagasaSource, inmetSource] });
  await collect(call, pagasaSource, upstream(pagasaSource, pagasa));
  await collect(call, inmetSource, upstream(inmetSource, inmet));
  const incidents: IncidentView[] = (
    await call("/api/snapshot", undefined, OWNER)
  ).body.incidents;
  const brief = structuredBrief(
    incidents,
    0,
    Date.parse("2026-10-23T08:00:00Z"),
  )!;
  // Warnings that had expired by then are left out.
  assert.deepEqual(
    brief.statements.map((s) => s.text),
    [
      "2 INMET severe weather warnings in Brazil.",
      "2 PAGASA flood warnings in the Philippines.",
    ],
  );
});
