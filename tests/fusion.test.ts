import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { parseUsgs } from "../src/collector/adapters/usgs.js";
import { parseGdacs } from "../src/collector/adapters/gdacs.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { fusionCandidates, sameEvent } from "../src/server/fusion.js";
import { structuredBrief } from "../src/server/structured-brief.js";
import { independence, situations } from "../src/shared/fusion.js";
import server, { type Env } from "../src/server/index.js";
import type { IncidentView, ObservationInput } from "../src/shared/contracts.js";

const usgsSource = sourceRegistry.find((s) => s.id === "global-usgs-earthquakes")!;
const gdacsSource = sourceRegistry.find((s) => s.id === "global-gdacs-alerts")!;
const usgsFixture = JSON.parse(readFileSync("tests/fixtures/usgs-summary.json", "utf8"));
const gdacsFixture = JSON.parse(readFileSync("tests/fixtures/gdacs-events.json", "utf8"));
const usgsTemplate = usgsFixture.features[0];
const gdacsQuakeTemplate = gdacsFixture.features.find(
  (f: any) => f.properties.eventid === 1572968,
);
const gdacsStormTemplate = gdacsFixture.features.find(
  (f: any) => f.properties.eventid === 1001338,
);

/** A ComCat summary feature in the fixture's exact shape. */
function usgsQuake(id: string, mag: number, time: string, lon: number, lat: number, place: string) {
  const f = structuredClone(usgsTemplate);
  f.id = id;
  Object.assign(f.properties, {
    mag,
    time: Date.parse(time),
    updated: Date.parse(time) + 600000,
    place,
    title: `M ${mag.toFixed(1)} - ${place}`,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/" + id,
    ids: `,${id},`,
    code: id.slice(2),
  });
  f.geometry.coordinates = [lon, lat, 10];
  return f;
}
const usgs = (...features: any[]) =>
  parseUsgs(usgsSource, {
    ...usgsFixture,
    metadata: { ...usgsFixture.metadata, count: features.length },
    features,
  });
/** A GDACS event-list earthquake in the fixture's exact shape; GDACS writes UTC without a zone and whole seconds. */
function gdacsQuake(
  eventid: number,
  mag: number | null,
  time: string,
  lon: number,
  lat: number,
  { level = "Red", source = "NEIC", country = "China", iso2 = "CN" } = {},
) {
  const f = structuredClone(gdacsQuakeTemplate);
  const utc = new Date(time).toISOString().slice(0, 19);
  Object.assign(f.properties, {
    eventid,
    episodeid: eventid + 100,
    name: "Earthquake in " + country,
    description: "Earthquake in " + country,
    alertlevel: level,
    episodealertlevel: level,
    country,
    affectedcountries: [{ iso2, iso3: "", countryname: country }],
    fromdate: utc,
    todate: utc,
    datemodified: utc,
    source,
    severitydata:
      mag === null
        ? { severity: 0, severitytext: "", severityunit: "" }
        : { severity: mag, severitytext: `Magnitude ${mag}M, Depth:10km`, severityunit: "M" },
  });
  f.geometry.coordinates = [lon, lat];
  return f;
}
function gdacsStorm(eventid: number, name: string, from: string, to: string, lon: number, lat: number) {
  const f = structuredClone(gdacsStormTemplate);
  Object.assign(f.properties, {
    eventid,
    episodeid: 1,
    eventname: name,
    name: "Tropical Cyclone " + name,
    description: "Tropical Cyclone " + name,
    fromdate: from,
    todate: to,
    datemodified: to,
  });
  f.geometry.coordinates = [lon, lat];
  return f;
}
const gdacs = (...features: any[]) =>
  parseGdacs(gdacsSource, { ...gdacsFixture, features });

/** The incident the structured path publishes for one record, as ingest builds it. */
function published(row: ObservationInput, id = row.native_id): IncidentView {
  const g = row.source_geo!;
  return {
    id,
    version: 1,
    headline: row.title,
    summary_en: "",
    summary_it: null,
    activity: row.official!.activity!,
    impact: row.official!.impact!,
    evidence_status: "official_advisory",
    location: { ...g, country: g.country ?? null, radius_km: g.radius_km ?? (g.accuracy === "area" ? 20 : 8) },
    event_start: row.official!.effective_at,
    event_end: null,
    published_at: null,
    ingested_at: "2026-10-22T12:00:00Z",
    analyzed_at: null,
    updated_at: "2026-10-22T12:00:00Z",
    expires_at: null,
    claims: [],
    reports: [
      {
        report_id: "r-" + id,
        source_id: row.source_id,
        source_name: row.source_id,
        excerpts: row.excerpts,
      },
    ],
    history: [],
    review_needed: false,
    cancelled: false,
  };
}
const verdict = (a: ObservationInput, b: ObservationInput) =>
  sameEvent(published(a), published(b));

// The M7.0 east-northeast of Nagqu on 22 October 2026, and GDACS's Red alert republishing the NEIC solution.
const MAIN = "2026-10-22T09:14:27.311Z";
const nagqu = () => usgs(usgsQuake("us7000r1qz", 7.0, MAIN, 93.73, 32.18, "191 km ENE of Nagqu, China"))[0];
const china = (over: Partial<{ mag: number | null; at: string; lon: number; lat: number; source: string }> = {}) =>
  gdacs(
    gdacsQuake(1573101, over.mag === undefined ? 7.0 : over.mag, over.at ?? MAIN, over.lon ?? 93.73, over.lat ?? 32.18, {
      source: over.source ?? "NEIC",
    }),
  )[0];
const later = (seconds: number) => new Date(Date.parse(MAIN) + seconds * 1000).toISOString();

test("GDACS republishing the NEIC solution is the same event and the same origin, not corroboration", () => {
  const link = verdict(nagqu(), china())!;
  assert.equal(link.type, "same_event");
  assert.equal(link.independence, "same_origin");
  assert.equal(link.basis, "fusion-1");
  assert.equal(
    link.reason,
    "origin times 0 s apart, epicentres 0 km apart (limit 40 km), magnitudes 0.0 apart; both measurements come from NEIC",
  );
  assert.equal(verdict(china(), nagqu())!.type, "same_event", "symmetric");
  assert.equal(verdict(nagqu(), china({ source: "USGS" }))!.independence, "same_origin");
  const emsc = verdict(nagqu(), china({ source: "EMSC" }))!;
  assert.equal(emsc.type, "same_event");
  assert.equal(emsc.independence, "independent");
  assert.match(emsc.reason, /measured by NEIC and EMSC$/);
  assert.equal(verdict(nagqu(), china({ source: "" }))!.independence, "unknown");
});

test("origin time, epicentre distance scaled by magnitude and magnitude tolerance decide; the margin stays possible", () => {
  const km = (east: number) => 93.73 + east / (111.32 * Math.cos((32.18 * Math.PI) / 180));
  assert.equal(verdict(nagqu(), china({ at: later(25) }))!.type, "same_event");
  assert.equal(verdict(nagqu(), china({ at: later(45) }))!.type, "possible_same_event");
  assert.equal(verdict(nagqu(), china({ at: later(130) })), null);
  assert.equal(verdict(nagqu(), china({ lon: km(38) }))!.type, "same_event", "M7 radius is 40 km");
  assert.equal(verdict(nagqu(), china({ lon: km(60) }))!.type, "possible_same_event");
  assert.equal(verdict(nagqu(), china({ lon: km(130) })), null);
  const small = usgs(usgsQuake("us6000u3uk", 4.9, MAIN, 93.73, 32.18, "x"))[0];
  assert.equal(
    verdict(small, china({ mag: 4.9, lon: km(30) }))!.type,
    "possible_same_event",
    "a moderate quake keeps the 25 km floor",
  );
  assert.equal(verdict(nagqu(), china({ mag: 6.8 }))!.type, "same_event", "GDACS keeps an earlier magnitude");
  assert.equal(verdict(nagqu(), china({ mag: 6.3 }))!.type, "possible_same_event");
  assert.equal(verdict(nagqu(), china({ mag: 5.8 })), null);
  const unstated = verdict(nagqu(), china({ mag: null }))!;
  assert.equal(unstated.type, "possible_same_event", "a missing magnitude never settles identity");
  assert.match(unstated.reason, /a magnitude is unstated/);
});

test("the real fixture pair fuses: GDACS's Vanuatu quake is the USGS record it names", () => {
  const vanuatu = parseUsgs(usgsSource, usgsFixture).find((r) => r.native_id === "us6000u3uk")!;
  const alert = parseGdacs(gdacsSource, gdacsFixture).find((r) => r.native_id === "EQ-1572968")!;
  assert.deepEqual(verdict(vanuatu, alert), {
    type: "same_event",
    independence: "same_origin",
    basis: "fusion-1",
    reason:
      "origin times 1 s apart, epicentres 0 km apart (limit 25 km), magnitudes 0.0 apart; both measurements come from NEIC",
  });
  for (const other of parseGdacs(gdacsSource, gdacsFixture).filter((r) => r.native_id !== alert.native_id))
    assert.equal(verdict(vanuatu, other), null, other.native_id);
});

test("two distinct nearby quakes stay apart, and a record between them is only possibly either", () => {
  const [first, second] = usgs(
    usgsQuake("us7000r1qa", 6.1, MAIN, 93.73, 32.18, "first"),
    usgsQuake("us7000r1qb", 6.0, later(40), 93.9, 32.2, "second"),
  );
  assert.equal(verdict(first, second), null, "one issuer's two event IDs are two quakes");
  const alert = china({ mag: 6.1 });
  assert.equal(verdict(first, alert)!.type, "same_event");
  assert.equal(verdict(second, alert)!.type, "possible_same_event");
  const views = [published(first), published(second), published(alert)];
  views[0].links = [{ incident_id: alert.native_id, ...verdict(first, alert)! }];
  views[2].links = [
    { incident_id: first.native_id, ...verdict(first, alert)! },
    { incident_id: second.native_id, ...verdict(second, alert)! },
  ];
  views[1].links = [{ incident_id: alert.native_id, ...verdict(second, alert)! }];
  assert.deepEqual(
    situations(views).map((s) => (s.members ?? [s]).map((m) => m.id)),
    [[first.native_id, alert.native_id], [second.native_id]],
  );
});

test("an aftershock sequence links only the mainshock to its alert, and the brief counts the mainshock once", () => {
  const quakes = usgs(
    usgsQuake("us7000r1qz", 7.0, MAIN, 93.73, 32.18, "191 km ENE of Nagqu, China"),
    usgsQuake("us7000r1r0", 5.8, later(50), 93.8, 32.2, "195 km ENE of Nagqu, China"),
    usgsQuake("us7000r1r1", 5.4, later(180), 93.6, 32.1, "180 km ENE of Nagqu, China"),
    usgsQuake("us7000r1r5", 4.6, later(7200), 93.75, 32.19, "190 km ENE of Nagqu, China"),
  );
  const alert = china();
  assert.deepEqual(
    quakes.map((q) => verdict(q, alert)?.type ?? null),
    ["same_event", null, null, null],
  );
  for (const a of quakes) for (const b of quakes) if (a !== b) assert.equal(verdict(a, b), null);
  const views = [...quakes, alert].map((r) => published(r));
  views[0].links = [{ incident_id: alert.native_id, ...verdict(quakes[0], alert)! }];
  views[4].links = [{ incident_id: quakes[0].native_id, ...verdict(quakes[0], alert)! }];
  const b = structuredBrief(views, 0, Date.parse("2026-10-22T12:00:00Z"))!;
  assert.equal(
    b.headline,
    "Red earthquake alert for M7.0 affecting China. 3 earthquakes M4.6+, largest M5.8 (195 km ENE of Nagqu, China).",
  );
  assert.deepEqual(b.statements[0].incident_ids, [quakes[0].native_id, alert.native_id]);
  assert.equal(b.counts.incidents, 4, "five records, four events");
  assert.equal(b.counts.reports, 5);
  assert.deepEqual(b.pins.map((p) => p.incident_id), [quakes[0].native_id]);
  assert.deepEqual(
    b.references.map((r) => r.incident_id).sort(),
    views.map((v) => v.id).sort(),
  );
});

test("a cyclone is matched by its storm name and season, never by a nearby storm", () => {
  const [champi] = gdacs(gdacsStormTemplate);
  const [renamed, nearby, older, months] = gdacs(
    gdacsStorm(1001400, "CHAMPI-26", "2026-10-22T00:00:00", "2026-10-22T12:00:00", 122.5, 23.4),
    gdacsStorm(1001401, "FUNG-WONG-26", "2026-10-20T00:00:00", "2026-10-21T12:00:00", 128.1, 19.6),
    gdacsStorm(1001402, "CHAMPI-21", "2026-10-20T00:00:00", "2026-10-21T12:00:00", 127.9, 19.3),
    gdacsStorm(1001403, "CHAMPI-26", "2026-05-01T00:00:00", "2026-05-03T00:00:00", 127.9, 19.3),
  );
  const link = verdict(champi, renamed)!;
  assert.equal(link.type, "same_event");
  assert.equal(link.independence, "same_origin");
  assert.equal(link.reason, "both records name CHAMPI-26; tracks 0.5 days and 721 km apart; both measurements come from JTWC");
  assert.equal(verdict(champi, nearby), null);
  assert.equal(verdict(champi, older), null);
  assert.equal(verdict(champi, months)!.type, "possible_same_event", "a reused name months apart is not settled");
});

test("fused situations lead with the most precise record, take the highest issuer level and honour operator splits", () => {
  const quake = published(nagqu(), "q"),
    alert = published(china(), "g");
  assert.equal(quake.impact, "unknown");
  assert.equal(alert.impact, "severe");
  const link = verdict(nagqu(), china())!;
  const other = { ...published(nagqu(), "z"), headline: "Unrelated" };
  const [fused, alone] = situations([
    { ...alert, links: [{ incident_id: "q", ...link }] },
    other,
    { ...quake, links: [{ incident_id: "g", ...link }] },
  ]);
  assert.equal(fused.id, "q", "the USGS epicentre point leads the GDACS centroid");
  assert.equal(fused.headline, "M 7.0 - 191 km ENE of Nagqu, China");
  assert.equal(fused.impact, "severe");
  assert.deepEqual(fused.members!.map((m) => m.id), ["q", "g"]);
  assert.equal(fused.reports.length, 2);
  assert.equal(independence(fused), "same_origin");
  assert.equal(alone, other, "an unlinked incident passes through unchanged");
  const split = { incident_id: "q", type: "split_from" as const, basis: "operator", reason: "r" };
  assert.equal(
    situations([
      { ...alert, links: [split] },
      { ...quake, links: [{ incident_id: "g", ...link }] },
    ]).length,
    2,
    "a split on either side wins over a stale same_event",
  );
  assert.equal(
    situations([{ ...quake, links: [{ incident_id: "absent", ...link }] }]).length,
    1,
    "a link to an incident outside the view fuses nothing",
  );
});

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
  const api = async (path: string, body?: unknown, token = "fixture-owner") => {
    const response = await server.fetch(
      new Request("https://fixture.invalid" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    db,
    reads,
    api,
    async ingest(rows: ObservationInput[]) {
      for (let i = 0; i < rows.length; i += 3)
        assert.equal((await api("/api/ingest", { observations: rows.slice(i, i + 3) }, "fixture-collector")).status, 200);
    },
    async incidents(): Promise<IncidentView[]> {
      return (await api("/api/snapshot?hours=0&include_incoming=0")).body.incidents;
    },
  };
}
// GDACS's two fixture earthquakes; its other alerts would crowd the brief's word budget.
const fixtureRows = () => [
  ...parseUsgs(usgsSource, usgsFixture),
  ...parseGdacs(gdacsSource, gdacsFixture).filter((r) => r.official?.activity === "earthquake"),
];
const by = (incidents: IncidentView[], title: string) =>
  incidents.find((i) => i.headline === title)!;

for (const order of ["USGS first", "GDACS first"])
  test(`ingesting the fixtures (${order}) links USGS and GDACS Vanuatu records on both incidents`, async () => {
    const s = fixtureServer();
    try {
      assert.equal((await s.api("/api/sources", { sources: [usgsSource, gdacsSource] }, "fixture-collector")).status, 200);
      const rows = fixtureRows();
      await s.ingest(order === "USGS first" ? rows : rows.reverse());
      const incidents = await s.incidents();
      const quake = by(incidents, "M 4.9 - 208 km WNW of Port-Olry, Vanuatu"),
        alert = by(incidents, "Earthquake in Vanuatu Islands");
      assert.deepEqual(quake.links?.map((l) => [l.incident_id, l.type, l.independence]), [
        [alert.id, "same_event", "same_origin"],
      ]);
      assert.deepEqual(alert.links?.map((l) => [l.incident_id, l.type, l.independence]), [
        [quake.id, "same_event", "same_origin"],
      ]);
      assert.equal(incidents.filter((i) => i.links).length, 2, "no other record is linked");
      const fused = situations(incidents);
      assert.equal(fused.length, incidents.length - 1, "one marker and one feed row for the pair");
      const pair = fused.find((v) => v.members)!;
      assert.equal(pair.id, quake.id);
      assert.deepEqual(pair.reports.map((r) => r.source_id), [usgsSource.id, gdacsSource.id]);
      // The record ingested first gained the link as a new audited revision.
      const first = order === "USGS first" ? quake : alert;
      const history = (await s.api("/api/incidents/" + first.id)).body.history;
      assert.ok(
        history.some((h: any) => /same-event links revised by fusion-1/.test(h.reason)),
        JSON.stringify(history.map((h: any) => h.reason)),
      );
      const brief = (await s.api("/api/brief?hours=0")).body.current;
      assert.match(brief.headline, /Green earthquake alert for M4\.9 in Vanuatu Islands\./);
      assert.match(brief.headline, /5 earthquakes M3\.8\+, largest M5\.2/, "the fused quake is not counted again");
    } finally {
      s.db.close();
    }
  });

test("candidate reads seek the cell and window index and return only rows inside the space and time window", async () => {
  const s = fixtureServer();
  try {
    assert.equal((await s.api("/api/sources", { sources: [usgsSource, gdacsSource] }, "fixture-collector")).status, 200);
    // 240 quakes: a third in the same latitude band but hours apart, the rest elsewhere.
    const crowd = usgs(
      ...Array.from({ length: 240 }, (_, n) =>
        usgsQuake(
          "us7000c" + String(n).padStart(3, "0"),
          5,
          later(n % 3 === 0 ? 3600 * (1 + n) : 60 * n),
          -170 + n * 1.4,
          n % 3 === 0 ? 32 + (n % 4) / 2 : -60 + (n % 80),
          "crowd " + n,
        ),
      ),
    ).filter((r) => Math.abs(r.source_geo!.lat - 32.18) > 3 || Math.abs(Date.parse(r.official!.effective_at!) - Date.parse(MAIN)) > 120000);
    await s.ingest([...crowd, nagqu()]);
    const all = s.db.prepare("SELECT count(*) AS n FROM incidents").get() as { n: number };
    const band = s.db
      .prepare("SELECT count(*) AS n FROM incidents WHERE abs(json_extract(view,'$.location.lat')-32.18)<=2.1")
      .get() as { n: number };
    s.reads.length = 0;
    await s.ingest([china()]);
    const candidates = s.reads.filter((r) => /INDEXED BY incidents_cell/.test(r.sql));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].rows, 1, "only the Nagqu record falls inside the window");
    assert.ok(band.n < all.n / 2, `the latitude band holds ${band.n} of ${all.n} incidents`);
    const query = fusionCandidates(published(china(), "probe"))!;
    const plan = (s.db.prepare("EXPLAIN QUERY PLAN " + query.sql).all(...(query.params as SQLInputValue[])) as { detail: string }[])
      .map((r) => r.detail)
      .join("\n");
    assert.match(plan, /^SEARCH incidents USING INDEX incidents_cell \(<expr>=\? AND <expr>>\?\)/);
    const storm = fusionCandidates(published(parseGdacs(gdacsSource, gdacsFixture).find((r) => r.native_id === "TC-1001338")!))!;
    const stormPlan = (s.db.prepare("EXPLAIN QUERY PLAN " + storm.sql).all(...(storm.params as SQLInputValue[])) as { detail: string }[])
      .map((r) => r.detail)
      .join("\n");
    assert.match(stormPlan, /VIRTUAL TABLE INDEX/, "cyclones are looked up by name through the search index");
    assert.equal(
      fusionCandidates(published(parseGdacs(gdacsSource, gdacsFixture).find((r) => r.native_id === "FL-1104220")!)),
      null,
      "hazards without a rule read nothing",
    );
  } finally {
    s.db.close();
  }
});

test("a cyclone GDACS lists under a second event ID fuses through the name lookup", async () => {
  const s = fixtureServer();
  try {
    assert.equal((await s.api("/api/sources", { sources: [gdacsSource] }, "fixture-collector")).status, 200);
    await s.ingest([
      ...gdacs(gdacsStormTemplate),
      ...gdacs(
        gdacsStorm(1001400, "CHAMPI-26", "2026-10-22T00:00:00", "2026-10-22T12:00:00", 122.5, 23.4),
        gdacsStorm(1001401, "FUNG-WONG-26", "2026-10-20T00:00:00", "2026-10-21T12:00:00", 128.1, 19.6),
      ),
    ]);
    const incidents = await s.incidents();
    const fused = situations(incidents);
    assert.deepEqual(
      fused.map((v) => (v.members ?? [v]).map((m) => m.headline)).sort(),
      [["Tropical Cyclone CHAMPI-26", "Tropical Cyclone CHAMPI-26"], ["Tropical Cyclone FUNG-WONG-26"]],
    );
  } finally {
    s.db.close();
  }
});

test("operators separate a fused pair without touching either record, and can hand it back to the rule", async () => {
  const s = fixtureServer();
  try {
    assert.equal((await s.api("/api/sources", { sources: [usgsSource, gdacsSource] }, "fixture-collector")).status, 200);
    await s.ingest([nagqu(), china()]);
    let [quake, alert] = await s.incidents().then((v) => [by(v, nagqu().title), by(v, china().title)]);
    const before = { quake: { ...quake, links: undefined, version: 0, updated_at: "" }, alert: { ...alert, links: undefined, version: 0, updated_at: "" } };
    assert.equal(situations([quake, alert]).length, 1);
    assert.equal((await s.api("/api/incidents/link", { ids: [quake.id, alert.id], linked: false })).status, 400, "an audit reason is required");
    assert.equal((await s.api("/api/incidents/link", { ids: [quake.id, quake.id], linked: false, reason: "same id" })).status, 400);
    const split = await s.api("/api/incidents/link", {
      ids: [quake.id, alert.id],
      linked: false,
      reason: "Analyst check: GDACS alert refers to a different shock",
    });
    assert.equal(split.status, 200);
    [quake, alert] = await s.incidents().then((v) => [by(v, nagqu().title), by(v, china().title)]);
    assert.equal(situations([quake, alert]).length, 2);
    assert.deepEqual(quake.links, [
      {
        incident_id: alert.id,
        type: "split_from",
        basis: "operator",
        reason: "Analyst check: GDACS alert refers to a different shock",
      },
    ]);
    assert.equal(alert.links?.[0].incident_id, quake.id);
    assert.equal(alert.links?.[0].type, "split_from");
    assert.deepEqual(
      { quake: { ...quake, links: undefined, version: 0, updated_at: "" }, alert: { ...alert, links: undefined, version: 0, updated_at: "" } },
      before,
      "both records keep their own fields and reports",
    );
    // A later USGS revision reruns the rule, which leaves the operator's decision in place.
    await s.ingest(usgs(usgsQuake("us7000r1qz", 7.1, MAIN, 93.74, 32.18, "191 km ENE of Nagqu, China")));
    [quake, alert] = await s.incidents().then((v) => [by(v, "M 7.1 - 191 km ENE of Nagqu, China"), by(v, china().title)]);
    assert.equal(quake.links?.[0].type, "split_from");
    assert.equal(situations([quake, alert]).length, 2);
    const restored = await s.api("/api/incidents/link", { ids: [alert.id, quake.id], linked: true, reason: "Recheck: same NEIC solution" });
    assert.equal(restored.status, 200);
    [quake, alert] = await s.incidents().then((v) => [by(v, "M 7.1 - 191 km ENE of Nagqu, China"), by(v, china().title)]);
    assert.equal(quake.links?.[0].type, "same_event");
    assert.equal(alert.links?.[0].basis, "fusion-1");
    assert.equal(situations([quake, alert]).length, 1);
    const history = (await s.api("/api/incidents/" + quake.id)).body.history.map((h: any) => h.reason);
    assert.ok(history.some((r: string) => r.startsWith(`separated from ${alert.id}: Analyst check`)));
    assert.ok(history.some((r: string) => r.startsWith(`same-event rule restored for ${alert.id}: Recheck`)));
  } finally {
    s.db.close();
  }
});

test("a revision that moves a record out of tolerance unlinks both sides, and evidence that never settles identity stays possible", async () => {
  const s = fixtureServer();
  try {
    assert.equal((await s.api("/api/sources", { sources: [usgsSource, gdacsSource] }, "fixture-collector")).status, 200);
    await s.ingest([nagqu(), china({ mag: null })]);
    let [quake, alert] = await s.incidents().then((v) => [by(v, nagqu().title), by(v, china().title)]);
    assert.equal(quake.links?.[0].type, "possible_same_event");
    assert.equal(alert.links?.[0].type, "possible_same_event");
    assert.equal(situations([quake, alert]).length, 2, "a possible match keeps both markers");
    await s.ingest([china()]);
    [quake, alert] = await s.incidents().then((v) => [by(v, nagqu().title), by(v, china().title)]);
    assert.equal(quake.links?.[0].type, "same_event");
    await s.ingest([china({ lat: 36.5 })]);
    [quake, alert] = await s.incidents().then((v) => [by(v, nagqu().title), by(v, china().title)]);
    assert.equal(quake.links, undefined);
    assert.equal(alert.links, undefined);
  } finally {
    s.db.close();
  }
});
