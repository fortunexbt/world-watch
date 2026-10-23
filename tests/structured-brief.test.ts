import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { structuredBrief } from "../src/server/structured-brief.js";
import { parseUsgs } from "../src/collector/adapters/usgs.js";
import { parseGdacs } from "../src/collector/adapters/gdacs.js";
import { parseNws } from "../src/collector/adapters/nws.js";
import { parseEccc } from "../src/collector/adapters/eccc.js";
import { parseAdsbLol } from "../src/collector/adapters/adsblol.js";
import { parseRipestatRouting } from "../src/collector/adapters/ripestat.js";
import { sourceRegistry } from "../src/collector/registry.js";
import server, { type Env } from "../src/server/index.js";
import type { IncidentView } from "../src/shared/contracts.js";

const clock = Date.parse("2026-10-22T12:00:00Z");
let serial = 0;
function view(
  record: Record<string, unknown>,
  extra: Partial<IncidentView> = {},
): IncidentView {
  const id = extra.id ?? `i${String(++serial).padStart(3, "0")}`;
  return {
    id,
    version: 1,
    headline: "Issuer record " + id,
    summary_en: "",
    summary_it: null,
    activity: "earthquake",
    impact: "unknown",
    evidence_status: "official_advisory",
    location: null,
    event_start: "2026-10-22T06:00:00Z",
    event_end: null,
    published_at: null,
    ingested_at: "2026-10-22T11:00:00Z",
    analyzed_at: null,
    updated_at: "2026-10-22T11:00:00Z",
    expires_at: null,
    claims: [],
    reports: [
      {
        report_id: "r-" + id,
        source_id: "fixture",
        excerpts: [{ id: "e", text: JSON.stringify(record) }],
      },
    ],
    history: [],
    review_needed: false,
    cancelled: false,
    ...extra,
  };
}
const quake = (
  magnitude: number,
  place: string | null,
  extra: Partial<IncidentView> = {},
) => view({ magnitude, place }, extra);
const alert = (
  level: string,
  activity: string,
  name: string,
  countries: string[],
  extra: Partial<IncidentView> = {},
) =>
  view(
    { alert_level: level, event_name: name || null, affected_countries: countries },
    {
      activity,
      impact: level === "Red" ? "severe" : level === "Orange" ? "significant" : "minor",
      ...extra,
    },
  );
const brief = (views: IncidentView[], hours = 168) =>
  structuredBrief(views, hours, clock)!;

test("structured brief states the top issuer alert and the earthquake count with every statement cited", () => {
  const champi = alert("Red", "tropical_cyclone", "CHAMPI-26", ["PH", "GU", "JP", "TW"], {
    event_start: "2026-10-14T12:00:00Z",
  });
  const ridge = quake(5.3, "Reykjanes Ridge", { event_start: "2026-10-22T02:00:00Z" });
  const quakes = [
    ridge,
    ...Array.from({ length: 20 }, (_, i) =>
      quake(4.5 + (i % 8) / 10, `${i} km N of Somewhere`, {
        event_start: `2026-10-21T${String(i).padStart(2, "0")}:00:00Z`,
      }),
    ),
  ];
  const b = brief([...quakes, champi]);
  assert.equal(
    b.headline,
    "Red tropical cyclone alert for CHAMPI-26 affecting the Philippines, Guam, Japan and Taiwan. 21 earthquakes M4.5+, largest M5.3 (Reykjanes Ridge).",
  );
  assert.ok(b.headline.split(/\s+/u).length <= 30);
  assert.equal(b.kind, "structured");
  assert.equal(b.statements.map((s) => s.text).join(" "), b.headline);
  assert.deepEqual(b.statements[0].incident_ids, [champi.id]);
  assert.deepEqual(
    [...b.statements[1].incident_ids].sort(),
    quakes.map((q) => q.id).sort(),
  );
  assert.equal(b.statements[1].incident_ids[0], ridge.id, "most recent first");
  assert.deepEqual(
    b.references.map((r) => r.incident_id),
    b.statements.flatMap((s) => s.incident_ids),
  );
  assert.deepEqual(b.pins, [
    {
      incident_id: champi.id,
      headline: champi.headline,
      impact: "severe",
      evidence_status: "official_advisory",
      version: 1,
    },
  ]);
  assert.deepEqual(b.counts, { reports: 22, incidents: 22, pending: 0, omitted: 0 });
  assert.equal(b.window_start, "2026-10-15T12:00:00.000Z");
  assert.equal(b.window_end, "2026-10-22T12:00:00.000Z");
  assert.equal(b.generated_at, "2026-10-22T12:00:00.000Z");
  assert.equal(brief([ridge], 0).window_start, null, "all observed has no start");
});

test("statements order by impact, then issuer event time, then id, and stop at the word budget", () => {
  const old = alert("Orange", "drought", "", ["BR"], { id: "b", event_start: "2026-09-01T00:00:00Z" });
  const recent = alert("Orange", "flood", "", ["NG"], { id: "c", event_start: "2026-10-21T00:00:00Z" });
  const tie = alert("Orange", "flood", "", ["NE"], { id: "a", event_start: "2026-10-21T00:00:00Z" });
  const red = alert("Red", "tropical_cyclone", "KONG-REY-26", ["TW"], { event_start: "2026-08-01T00:00:00Z" });
  const minor = alert("Green", "wildfire", "", ["ZW", "MZ", "ZA", "BW", "NA"], {
    event_start: "2026-10-22T11:00:00Z",
  });
  const short = quake(5, "Short");
  const b = brief([short, minor, old, tie, recent, red]);
  assert.deepEqual(b.statements, [
    { text: "Red tropical cyclone alert for KONG-REY-26 affecting Taiwan.", incident_ids: [red.id] },
    { text: "Orange flood alert affecting Niger.", incident_ids: ["a"] },
    { text: "Orange flood alert affecting Nigeria.", incident_ids: ["c"] },
    { text: "Orange drought alert affecting Brazil.", incident_ids: ["b"] },
  ]);
  assert.equal(b.headline.split(/\s+/u).length, 23);
  assert.equal(
    b.counts.omitted,
    2,
    "the wildfire would exceed 30 words, and the shorter earthquake after it is not promoted past it",
  );
  assert.deepEqual(
    b.pins.map((p) => p.incident_id),
    [red.id, "a", "c"],
    "at most three pins, important first",
  );
  assert.ok(!b.references.some((r) => [minor.id, short.id].includes(r.incident_id)));
});

test("counts pluralise and the magnitude floor never overstates the smallest event", () => {
  assert.equal(brief([quake(5.3, "Reykjanes Ridge")]).headline, "1 earthquake, M5.3 (Reykjanes Ridge).");
  assert.equal(
    brief([quake(4.56, null), quake(4.9, null)]).headline,
    "2 earthquakes M4.5+, largest M4.9.",
  );
  const displacement = { activity: "displacement" };
  assert.equal(brief([view({}, displacement)]).headline, "1 displacement record.");
  assert.equal(
    brief([view({}, displacement), view({}, displacement), quake(Number.NaN, "x")]).headline,
    "2 displacement records. 1 earthquake record.",
  );
});

test("NWS and ECCC warnings are counted per issuer, hazard and country", () => {
  const source = (id: string) => sourceRegistry.find((s) => s.id === id)!;
  const published = (row: ReturnType<typeof parseNws>[number]) =>
    view(JSON.parse(row.excerpts[0].text), {
      activity: row.official!.activity!,
      impact: row.official!.impact!,
      cancelled: row.official!.cancelled ?? false,
      event_start: row.official!.effective_at,
      location: { ...row.source_geo!, country: row.source_geo!.country ?? null, radius_km: row.source_geo!.radius_km ?? 20 },
    });
  const nws = parseNws(
    source("us-nws-warnings"),
    JSON.parse(readFileSync("tests/fixtures/nws-alerts.json", "utf8")),
  ).map(published);
  const eccc = parseEccc(
    source("ca-eccc-warnings"),
    JSON.parse(readFileSync("tests/fixtures/eccc-alerts.json", "utf8")),
  ).map(published);
  // The fixture's two cancelled NWS warnings are left out, and the severe thunderstorm warning, issued last, leads its equals.
  const b = structuredBrief([...nws, ...eccc], 168, Date.parse("2026-10-22T16:00:00Z"))!;
  assert.deepEqual(
    b.statements.map((s) => s.text),
    [
      "1 NWS severe weather warning in the United States.",
      "3 NWS flood warnings in the United States.",
      "5 ECCC severe weather warnings in Canada.",
    ],
  );
  assert.deepEqual(
    b.statements.flatMap((s) => s.incident_ids).sort(),
    [...nws.filter((v) => !v.cancelled), ...eccc].map((v) => v.id).sort(),
  );
});

test("ADSB.lol aircraft are counted per squawk code as unverified reports, the most serious code first", () => {
  const source = sourceRegistry.find((s) => s.id === "global-adsblol-emergency-squawks")!;
  const fixture = JSON.parse(readFileSync("tests/fixtures/adsblol-aircraft.json", "utf8"));
  const codes = ["7700", "7600", "7700", "7500", "7700", "7600", "7700"];
  fixture.ac.forEach((a: any, i: number) => (a.squawk = codes[i]));
  const aircraft = parseAdsbLol(source, fixture).map((row) =>
    view(JSON.parse(row.excerpts[0].text), {
      activity: row.official!.activity!,
      impact: row.official!.impact!,
      evidence_status: "unverified",
    }),
  );
  const b = brief(aircraft);
  assert.deepEqual(
    b.statements.map((s) => s.text),
    [
      "1 aircraft reported squawking 7500 (unlawful interference).",
      "4 aircraft reported squawking 7700 (general emergency).",
      "2 aircraft reported squawking 7600 (radio failure).",
    ],
  );
  // 7500 maps to significant, the only level that pins; nothing reaches severe.
  assert.deepEqual(b.pins.map((p) => [p.impact, p.evidence_status]), [["significant", "unverified"]]);
  // An analysed unverified record is model output, never a structured one.
  assert.equal(structuredBrief(aircraft.map((v) => ({ ...v, analyzed_at: "2026-10-22T11:00:00Z" })), 168, clock), null);
});

test("routing drops are briefed as measured connectivity drops in their countries, and recovered ones drop out", () => {
  const source = sourceRegistry.find((s) => s.id === "global-ripestat-routing")!;
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/ripestat-routing.json", "utf8"),
  );
  const published = (
    country: string,
    payload: unknown,
    at: number,
    extra: Partial<IncidentView> = {},
  ) =>
    parseRipestatRouting(source, country, payload, at)!.map((row) =>
      view(JSON.parse(row.excerpts[0].text), {
        activity: row.official!.activity!,
        impact: row.official!.impact!,
        event_start: row.official!.effective_at,
        expires_at: row.official!.expires_at,
        location: { ...row.source_geo!, country: row.source_geo!.country ?? null, radius_km: row.source_geo!.radius_km! },
        ...extra,
      }),
    );
  // Both real shutdowns, published as still open, then Syria's as recovered.
  const [iran] = published("IR", fixture["ir-2019"], Date.parse("2019-11-21T14:00:00Z"), { expires_at: null, current_listing: true });
  const [syria] = published("SY", fixture["sy-2012"], Date.parse("2012-12-01T17:00:00Z"), { expires_at: null, current_listing: true });
  const at = Date.parse("2019-11-21T15:00:00Z");
  assert.deepEqual(
    structuredBrief([iran], 24, at)!.statements.map((s) => s.text),
    ["Internet connectivity drop measured in Iran."],
  );
  const both = structuredBrief([iran, syria], 24, at)!;
  assert.deepEqual(both.statements.map((s) => s.text), [
    "Internet connectivity drops measured in Syria and Iran.",
  ]);
  assert.deepEqual(both.statements[0].incident_ids, [syria.id, iran.id]);
  assert.deepEqual(both.pins.map((p) => p.incident_id), [syria.id, iran.id]);
  const [ended] = published("SY", fixture["sy-2012"], Date.parse("2012-12-01T17:00:00Z"));
  assert.equal(structuredBrief([ended], 24, Date.parse("2012-12-01T17:00:00Z")), null);
});

test("affected countries are named with articles, deduplicated and capped, with the issuer text as fallback", () => {
  const text = (countries: string[], extra: Record<string, unknown> = {}) =>
    brief([view({ alert_level: "Orange", affected_countries: countries, ...extra }, { activity: "flood" })]).headline;
  assert.equal(text(["IT"]), "Orange flood alert affecting Italy.");
  assert.equal(text(["JP", "TW", "JP"]), "Orange flood alert affecting Japan and Taiwan.");
  assert.equal(text(["US", "GB", "NL"]), "Orange flood alert affecting the United States, the United Kingdom and the Netherlands.");
  assert.equal(
    text(["PH", "GU", "JP", "TW", "MP"]),
    "Orange flood alert affecting the Philippines, Guam, Japan and 2 other countries.",
  );
  assert.equal(text(["it", "ITA"], { countries: "Vanuatu Islands" }), "Orange flood alert in Vanuatu Islands.");
  assert.equal(text([]), "Orange flood alert.");
});

test("an empty window, model output, cancellations, expiries and superseded records produce no structured brief", () => {
  assert.equal(structuredBrief([], 168, clock), null);
  assert.equal(
    structuredBrief(
      [
        quake(5, "a", { analyzed_at: "2026-10-22T11:00:00Z" }),
        quake(5, "b", { evidence_status: "corrected" }),
        quake(5, "c", { cancelled: true }),
        quake(5, "d", { expires_at: "2026-10-22T12:00:00Z" }),
        quake(5, "e", { superseded_by: "other" }),
      ],
      168,
      clock,
    ),
    null,
  );
  assert.equal(
    brief([quake(5, "live", { expires_at: "2026-10-22T12:00:01Z" })]).headline,
    "1 earthquake, M5.0 (live).",
  );
});

test("equal magnitudes name the more important, then more recent, then lowest-id event", () => {
  const early = quake(5.3, "Early", { id: "q1", event_start: "2026-10-22T01:00:00Z" });
  const late = quake(5.3, "Late", { id: "q2", event_start: "2026-10-22T09:00:00Z" });
  assert.match(brief([early, late]).headline, /M5\.3 \(Late\)/);
  const pager = quake(5.3, "Pager", { id: "q3", impact: "significant", event_start: "2026-10-20T00:00:00Z" });
  assert.match(brief([early, late, pager]).headline, /M5\.3 \(Pager\)/);
  const twin = quake(5.3, "Twin", { id: "q0", event_start: "2026-10-22T09:00:00Z" });
  const b = brief([late, twin]);
  assert.match(b.headline, /M5\.3 \(Twin\)/);
  assert.deepEqual(b.statements[0].incident_ids, ["q0", "q2"]);
});

const usgsSource = sourceRegistry.find((s) => s.id === "global-usgs-earthquakes")!;
const gdacsSource = sourceRegistry.find((s) => s.id === "global-gdacs-alerts")!;
function fixtureServer() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  const reads: { sql: string; rows: number }[] = [];
  // node:sqlite exposes no scanned-row counter, so rows returned stand in for D1 rows_read.
  const prepare = (sql: string) => {
    let values: SQLInputValue[] = [];
    return {
      bind(...next: SQLInputValue[]) {
        values = next;
        return this;
      },
      async all() {
        const results = db.prepare(sql).all(...values);
        reads.push({ sql, rows: results.length });
        return { results, meta: { rows_read: results.length, rows_written: 0 } };
      },
      async run() {
        const result = db.prepare(sql).run(...values);
        return { meta: { rows_read: 0, rows_written: Number(result.changes) } };
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
    reads,
    async api(path: string, body?: unknown, token = "fixture-owner") {
      const response = await server.fetch(
        new Request("https://fixture.invalid" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
      return {
        status: response.status,
        rowsRead: Number(response.headers.get("x-ew-rows-read")),
        body: (await response.json()) as any,
      };
    },
  };
}
async function hazards() {
  const s = fixtureServer();
  assert.equal((await s.api("/api/sources", { sources: [usgsSource, gdacsSource] }, "fixture-collector")).status, 200);
  // The live feed requests Orange and Red only; expiry is cleared so the fixture stays current.
  const rows = [
    ...parseUsgs(usgsSource, JSON.parse(readFileSync("tests/fixtures/usgs-summary.json", "utf8"))),
    ...parseGdacs(gdacsSource, JSON.parse(readFileSync("tests/fixtures/gdacs-events.json", "utf8")))
      .filter((r) => r.title === "Tropical Cyclone CHAMPI-26")
      .map((r) => ({ ...r, official: { ...r.official!, expires_at: null } })),
  ];
  for (let i = 0; i < rows.length; i += 3)
    assert.equal((await s.api("/api/ingest", { observations: rows.slice(i, i + 3) }, "fixture-collector")).status, 200);
  return s;
}

test("/api/brief serves the structured brief in the model brief shape until an analysis worker is seen", async () => {
  const s = await hazards();
  try {
    const response = await s.api("/api/brief?hours=0");
    assert.equal(response.status, 200);
    assert.equal(response.body.pending, false);
    const b = response.body.current;
    assert.equal(b.kind, "structured");
    assert.equal(
      b.headline,
      "Red tropical cyclone alert for CHAMPI-26 affecting the Philippines, Guam and Japan. 6 earthquakes M3.8+, largest M5.2 (68 km NE of Cabatuan, Philippines).",
    );
    const incidents: IncidentView[] = (await s.api("/api/snapshot?hours=0")).body.incidents;
    const champi = incidents.find((i) => i.headline === "Tropical Cyclone CHAMPI-26")!;
    assert.deepEqual(b.statements[0].incident_ids, [champi.id]);
    assert.deepEqual(
      [...b.statements[1].incident_ids].sort(),
      incidents.filter((i) => i.activity === "earthquake").map((i) => i.id).sort(),
    );
    for (const ref of b.references)
      assert.equal(ref.headline, incidents.find((i) => i.id === ref.incident_id)?.headline);
    assert.deepEqual(b.pins.map((p: any) => p.incident_id), [champi.id]);
    assert.deepEqual(b.counts, { reports: 7, incidents: 7, pending: 0, omitted: 0 });
    for (const key of ["id", "window_start", "window_end", "generated_at"]) assert.ok(key in b);
    assert.equal((await s.api("/api/brief?hours=0", undefined, "fixture-worker")).status, 403);
    s.db.prepare("INSERT INTO workers(id,last_seen,state) VALUES('mac',?,'offline')").run("2026-10-01T00:00:00Z");
    assert.equal((await s.api("/api/brief?hours=0")).body.current, null, "a seen worker owns the brief");
  } finally {
    s.db.close();
  }
});

test("a published model brief wins over issuer fields and is never merged with them", async () => {
  const s = await hazards();
  try {
    const at = new Date().toISOString();
    s.db.prepare("INSERT INTO sources(id,record) VALUES('news',?)").run(
      JSON.stringify({ status: "enabled", config: {}, rights: { access: true, storage: true, display: true, ai: true } }),
    );
    s.db.prepare(
      "INSERT INTO observations(id,source_id,native_id,canonical_url,first_observed_at,latest_revision) VALUES('r','news','n','https://fixture.invalid/r',?,'v1')",
    ).run(at);
    const input = {
      window_start: at,
      window_end: at,
      incidents: [{ index: 0, incident_id: "model", headline: "Model incident" }],
      counts: { reports: 1, incidents: 1, pending: 0, omitted: 0 },
    };
    s.db.prepare(
      "INSERT INTO brief_windows(id,window_start,window_end,state,input,provenance,result,run,created_at,updated_at,available_at) VALUES('brief:m',?,?,'complete',?,?,?,'{}',?,?,?)",
    ).run(
      at,
      at,
      JSON.stringify(input),
      JSON.stringify([{ index: 0, incident_id: "model", version: 1, reports: [{ report_id: "r", revision: "v1", source_id: "news" }] }]),
      JSON.stringify({ headline: "Model headline.", references: [0], pinned: [] }),
      at,
      at,
      at,
    );
    const b = (await s.api("/api/brief?hours=0")).body.current;
    assert.equal(b.kind, "model");
    assert.equal(b.headline, "Model headline.");
    assert.deepEqual(b.references.map((r: any) => r.incident_id), ["model"]);
  } finally {
    s.db.close();
  }
});

test("the structured brief reuses the snapshot's live read and then answers polls from memory", async () => {
  const s = await hazards();
  try {
    const incidentReads = () => s.reads.filter((r) => /FROM incidents/.test(r.sql)).length;
    s.reads.length = 0;
    const snapshot = await s.api("/api/snapshot?hours=168&include_incoming=0");
    assert.equal(incidentReads(), 1);
    s.reads.length = 0;
    const first = await s.api("/api/brief?hours=168");
    assert.equal(first.body.current.kind, "structured");
    assert.equal(incidentReads(), 0, "the brief reuses the snapshot's live incident read");
    const cold = [...s.reads];
    s.reads.length = 0;
    const polls = [];
    for (let i = 0; i < 5; i++) polls.push((await s.api("/api/brief?hours=168")).rowsRead);
    assert.equal(incidentReads(), 0, "polls inside the five-minute memo read no incidents");
    assert.ok(!s.reads.some((r) => /FROM sources/.test(r.sql)), "polls read no source registry");
    assert.deepEqual(polls, [0, 0, 0, 0, 0]);
    assert.ok(first.rowsRead <= snapshot.rowsRead, `brief ${first.rowsRead} rows, snapshot ${snapshot.rowsRead}`);
    assert.deepEqual(
      cold.map((r) => r.sql.match(/FROM (\w+)/)?.[1]),
      ["brief_windows", "brief_windows", "workers", "sources", "sources"],
      "beyond the shared head the cold brief reads only brief state, the worker check, source rights and the GDELT sources' rights",
    );
  } finally {
    s.db.close();
  }
});
