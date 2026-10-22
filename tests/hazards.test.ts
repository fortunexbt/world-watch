import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  parseUsgs,
  PAGER_IMPACT,
  USGS_FEED_URL,
} from "../src/collector/adapters/usgs.js";
import {
  parseGdacs,
  GDACS_IMPACT,
  GDACS_EVENTS_URL,
} from "../src/collector/adapters/gdacs.js";
import { collectSources } from "../src/collector/index.js";
import {
  configuredRegistry,
  sourceRegistry,
} from "../src/collector/registry.js";
import server, { type Env } from "../src/server/index.js";
import type {
  IncidentView,
  ObservationInput,
  SourceRecord,
} from "../src/shared/contracts.js";

// Trimmed from real responses fetched 2026-10-21: USGS summary/2.5_day.geojson and the GDACS
// Green;Orange;Red event list. Alert, tsunami and hazard-type variants absent from that day are
// derived below by editing clones, never by editing the fixture files.
const usgs = JSON.parse(
  readFileSync("tests/fixtures/usgs-summary.json", "utf8"),
);
const gdacs = JSON.parse(
  readFileSync("tests/fixtures/gdacs-events.json", "utf8"),
);
const usgsSource = sourceRegistry.find(
  (s) => s.id === "global-usgs-earthquakes",
)!;
const gdacsSource = sourceRegistry.find((s) => s.id === "global-gdacs-alerts")!;
const byId = (rows: ObservationInput[], id: string) =>
  rows.find((r) => r.native_id === id)!;
const record = (row: ObservationInput) => JSON.parse(row.excerpts[0].text);

test("USGS epicentres keep native ID, revision clock, depth and exact point with no invented country or impact", () => {
  const rows = parseUsgs(usgsSource, usgs);
  assert.equal(rows.length, 6);
  const feature = usgs.features.find((f: any) => f.id === "us6000u3uk");
  const vanuatu = byId(rows, "us6000u3uk");
  assert.equal(vanuatu.source_event_id, "us6000u3uk");
  assert.equal(vanuatu.title, "M 4.9 - 208 km WNW of Port-Olry, Vanuatu");
  assert.equal(
    vanuatu.canonical_url,
    "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u3uk",
  );
  assert.equal(vanuatu.published_at, null);
  assert.equal(
    vanuatu.source_updated_at,
    new Date(feature.properties.updated).toISOString(),
  );
  assert.equal(
    vanuatu.official?.effective_at,
    new Date(feature.properties.time).toISOString(),
  );
  assert.deepEqual(vanuatu.source_geo, {
    lon: 165.3793,
    lat: -14.1338,
    name: "208 km WNW of Port-Olry, Vanuatu",
    accuracy: "point",
    country: null,
  });
  assert.equal(vanuatu.official?.activity, "earthquake");
  assert.equal(vanuatu.official?.impact, "unknown");
  const excerpt = record(vanuatu);
  assert.equal(excerpt.magnitude, 4.9);
  assert.equal(excerpt.depth_km, 10);
  assert.equal(excerpt.pager_alert, null);
  assert.equal(excerpt.tsunami_flag, false);
  assert.match(excerpt.notice, /epicentre, not the shaking footprint/);
  // Both sides of the antimeridian stay as published; nothing is wrapped or averaged.
  assert.equal(byId(rows, "us6000u3r3").source_geo?.lon, 179.592);
  assert.equal(byId(rows, "us6000u3p9").source_geo?.lon, -178.9413);
  assert.deepEqual(record(byId(rows, "tx2026usvdxs")).network_ids, [
    "us6000u3tu",
    "tx2026usvdxs",
  ]);
});

test("PAGER alert maps conservatively to impact, never critical, and the tsunami flag is not a tsunami claim", () => {
  for (const [alert, impact] of Object.entries(PAGER_IMPACT)) {
    const copy = structuredClone(usgs);
    copy.features[0].properties.alert = alert;
    const [row] = parseUsgs(usgsSource, copy);
    assert.equal(row.official?.impact, impact);
    assert.equal(record(row).pager_alert, alert);
  }
  assert.equal(PAGER_IMPACT.red, "severe");
  const odd = structuredClone(usgs);
  odd.features[0].properties.alert = "purple";
  odd.features[0].properties.tsunami = 1;
  const [row] = parseUsgs(usgsSource, odd);
  assert.equal(row.official?.impact, "unknown");
  assert.equal(record(row).tsunami_flag, true);
  assert.match(record(row).notice, /does not mean a tsunami occurred/);
});

test("USGS non-earthquake types, missing points and truncated or invalid feeds never become guessed events", () => {
  const copy = structuredClone(usgs);
  copy.features[0].properties.type = "quarry blast";
  copy.features[1].geometry.coordinates = [999, 13, 10];
  copy.features[2].geometry = null;
  const rows = parseUsgs(usgsSource, copy);
  assert.equal(rows.length, 5);
  assert(!rows.some((r) => r.native_id === copy.features[0].id));
  assert.equal(byId(rows, copy.features[1].id).source_geo, undefined);
  assert.equal(byId(rows, copy.features[2].id).source_geo, undefined);
  assert.throws(
    () => parseUsgs(usgsSource, { ...usgs, metadata: { count: 7 } }),
    /usgs_feed_truncated/,
  );
  assert.throws(
    () => parseUsgs(usgsSource, { error: 1 }),
    /invalid_usgs_response/,
  );
  assert.deepEqual(
    parseUsgs(usgsSource, {
      type: "FeatureCollection",
      metadata: { count: 0 },
      features: [],
    }),
    [],
  );
});

test("GDACS events keep type plus event ID, episode revision, UTC dates, centroid accuracy and single affected country", () => {
  const rows = parseGdacs(gdacsSource, gdacs);
  assert.equal(rows.length, 6);
  const champi = byId(rows, "TC-1001338");
  assert.equal(champi.source_event_id, "TC-1001338");
  assert.equal(champi.title, "Tropical Cyclone CHAMPI-26");
  assert.equal(
    champi.canonical_url,
    "https://www.gdacs.org/report.aspx?eventid=1001338&episodeid=29&eventtype=TC",
  );
  assert.equal(champi.official?.effective_at, "2026-10-14T12:00:00.000Z");
  assert.equal(champi.official?.expires_at, null);
  assert.equal(champi.official?.current_listing, true);
  assert.equal(champi.source_updated_at, "2026-10-21T15:01:38.000Z");
  assert.equal(champi.official?.activity, "tropical_cyclone");
  assert.equal(champi.official?.impact, "severe");
  assert.equal(champi.source_geo?.accuracy, "area");
  assert.equal(champi.source_geo?.country, null);
  const excerpt = record(champi);
  assert.equal(excerpt.alert_level, "Red");
  assert.equal(excerpt.episode_alert_level, "Green");
  assert.equal(excerpt.episode_id, 29);
  assert.equal(excerpt.to, "2026-10-21T12:00:00.000Z");
  assert.deepEqual(excerpt.affected_countries, ["PH", "GU", "JP"]);
  assert.equal(excerpt.hazard_data_source, "JTWC");
  assert.match(excerpt.notice, /not for decision making without confirmation/);
  assert.match(excerpt.notice, /not an impact footprint/);
  assert.match(excerpt.notice, /third-party material/);
  assert.match(excerpt.notice, /while GDACS lists it as current/);
  const japan = byId(rows, "EQ-1572939");
  assert.equal(japan.source_geo?.country, "JP");
  assert.equal(japan.official?.activity, "earthquake");
  assert.equal(japan.official?.impact, GDACS_IMPACT.Green);
  assert.equal(byId(rows, "EQ-1572968").source_geo?.country, null);
  assert.equal(
    byId(rows, "TC-1001341").source_geo?.name,
    "Tropical Cyclone TWENTY-TWO-E-26",
  );
  assert.equal(byId(rows, "WF-1032988").source_geo?.country, null);
  assert.equal(byId(rows, "FL-1104220").official?.activity, "flood");
  assert.equal(byId(rows, "WF-1032988").official?.activity, "wildfire");
});

test("a new GDACS episode is a new revision of the same event, and every listed hazard type is classified", () => {
  const next = structuredClone(gdacs);
  const tc = next.features.find((f: any) => f.properties.eventid === 1001338);
  tc.properties.episodeid = 30;
  const [before, after] = [gdacs, next].map((p) =>
    byId(parseGdacs(gdacsSource, p), "TC-1001338"),
  );
  assert.equal(before.native_id, after.native_id);
  assert.notEqual(before.excerpts[0].text, after.excerpts[0].text);
  assert.match(after.canonical_url, /episodeid=30/);
  const variants = structuredClone(gdacs);
  variants.features[0].properties.eventtype = "VO";
  variants.features[1].properties.eventtype = "DR";
  variants.features[2].properties.eventtype = "XX";
  variants.features[3].properties.fromdate = "not a date";
  variants.features[4].properties.alertlevel = "Orange";
  const rows = parseGdacs(gdacsSource, variants);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].official?.activity, "volcanic_eruption");
  assert.equal(rows[1].official?.activity, "drought");
  assert.equal(rows[2].official?.impact, "significant");
  assert(rows.every((r) => r.official?.impact !== "critical"));
});

test("malformed GDACS pages fail visibly and invalid points are dropped", () => {
  assert.throws(
    () => parseGdacs(gdacsSource, { features: {} }),
    /invalid_gdacs_response/,
  );
  const bad = structuredClone(gdacs);
  bad.features[0].geometry.coordinates = [200, 0];
  assert.equal(parseGdacs(gdacsSource, bad)[0].source_geo, undefined);
});

test("worldwide sources survive country filtering and collect through dedicated parsers as structured hazard records", async () => {
  for (const id of [usgsSource.id, gdacsSource.id])
    assert(configuredRegistry({ countries: ["IT"] }).some((s) => s.id === id));
  assert(
    !configuredRegistry({ countries: ["IT"] }).some((s) => s.id === "de-dwd"),
  );
  for (const s of [usgsSource, gdacsSource]) {
    assert.deepEqual(s.countries, ["*"]);
    assert.equal(s.rights.ai, false);
    assert.equal(s.rights.display, true);
  }
  const accepted: ObservationInput[] = [];
  const requested: string[] = [];
  const results = await collectSources(
    {
      EW_API_URL: "https://isolated.invalid",
      EW_COLLECTOR_TOKEN: "isolated-fixture",
    },
    {
      sources: [usgsSource, gdacsSource],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async () => {},
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      fetch: async (url) => {
        requested.push(String(url));
        if (String(url).endsWith("/reconcile"))
          return Response.json({ changed: 0, more: false });
        return Response.json(String(url) === USGS_FEED_URL ? usgs : gdacs);
      },
      maxRequests: 40,
      now: () => Date.parse("2026-10-21T18:00:00Z"),
    },
  );
  // GDACS states which events are current, so a complete read reconciles that set; USGS is a rolling window.
  assert.deepEqual(requested, [
    USGS_FEED_URL,
    GDACS_EVENTS_URL,
    "https://isolated.invalid/api/sources/global-gdacs-alerts/reconcile",
  ]);
  assert.deepEqual(
    results.map((r) => [r.source_id, r.status, r.received]),
    [
      ["global-usgs-earthquakes", "ok", 6],
      ["global-gdacs-alerts", "ok", 6],
    ],
  );
  assert(
    accepted.every(
      (x) =>
        x.eligibility?.eligible &&
        x.eligibility.reason === "structured_natural_hazard_record",
    ),
  );
});

function fixtureServer() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
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
      async first() {
        return db.prepare(sql).get(...values) ?? null;
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
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
      return { status: response.status, body: (await response.json()) as any };
    },
  };
}

test("non-European USGS and GDACS records publish as classified incidents with source country and no analysis work", async () => {
  const s = fixtureServer();
  try {
    const sources: SourceRecord[] = [usgsSource, gdacsSource];
    assert.equal(
      (await s.api("/api/sources", { sources }, "fixture-collector")).status,
      200,
    );
    const orange = structuredClone(usgs);
    orange.features.find((f: any) => f.id === "us6000u3t6").properties.alert =
      "orange";
    const rows = [
      ...parseUsgs(usgsSource, orange),
      ...parseGdacs(gdacsSource, gdacs),
    ];
    for (let i = 0; i < rows.length; i += 3)
      assert.equal(
        (
          await s.api(
            "/api/ingest",
            { observations: rows.slice(i, i + 3) },
            "fixture-collector",
          )
        ).status,
        200,
      );
    const incidents: IncidentView[] = (await s.api("/api/snapshot")).body
      .incidents;
    assert.equal(incidents.length, 12);
    const find = (title: string) =>
      incidents.find((i) => i.headline === title)!;
    const philippines = find("M 5.2 - 68 km NE of Cabatuan, Philippines");
    assert.equal(philippines.activity, "earthquake");
    assert.equal(philippines.impact, "severe");
    assert.equal(philippines.evidence_status, "official_advisory");
    assert.deepEqual(philippines.location, {
      lon: 125.5898,
      lat: 13.0297,
      name: "68 km NE of Cabatuan, Philippines",
      accuracy: "point",
      country: null,
      radius_km: 8,
    });
    assert.equal(
      philippines.reports[0].rights.attribution,
      usgsSource.rights.attribution,
    );
    const japan = find("Earthquake in Japan");
    assert.equal(japan.activity, "earthquake");
    assert.equal(japan.impact, "minor");
    assert.equal(japan.location?.country, "JP");
    assert.equal(japan.location?.accuracy, "area");
    const champi = find("Tropical Cyclone CHAMPI-26");
    assert.equal(champi.activity, "tropical_cyclone");
    assert.equal(champi.impact, "severe");
    assert.equal(champi.location?.country, null);
    assert.equal(champi.event_start, "2026-10-14T12:00:00.000Z");
    assert.equal(
      find("M 4.9 - south of the Fiji Islands").location?.lon,
      179.592,
    );
    assert(incidents.every((i) => i.location?.country !== "*"));
    assert.deepEqual(
      s.db
        .prepare("SELECT DISTINCT state,error_kind FROM analysis_jobs")
        .all()
        .map((r) => ({ ...r })),
      [{ state: "blocked", error_kind: "rights" }],
    );
    assert.equal(
      (await s.api("/api/worker/claim", { worker_id: "mac" }, "fixture-worker"))
        .body.leases.length,
      0,
    );
    const invalid = await s.api(
      "/api/ingest",
      {
        observations: [
          { ...rows[0], official: { ...rows[0].official, activity: "meteor" } },
        ],
      },
      "fixture-collector",
    );
    assert.equal(invalid.body.error, "invalid_official_classification");
    const country = await s.api(
      "/api/ingest",
      {
        observations: [
          { ...rows[0], source_geo: { ...rows[0].source_geo, country: "*" } },
        ],
      },
      "fixture-collector",
    );
    assert.equal(country.body.error, "invalid_geography");
  } finally {
    s.db.close();
  }
});

test("archived GDACS events are not published to the live map", () => {
  const archived = structuredClone(gdacs);
  for (const feature of archived.features) feature.properties.iscurrent = "false";
  archived.features[0].properties.iscurrent = "true";
  assert.deepEqual(
    parseGdacs(gdacsSource, archived).map((row) => row.native_id),
    [`${gdacs.features[0].properties.eventtype}-${gdacs.features[0].properties.eventid}`],
  );
});

test("USGS epicentres take a country only well inside one map polygon, never offshore or near a border", () => {
  // Real-shaped: the fixture's Vanuatu trench and Texas events, plus clones moved to inland
  // Honshu, inland Namibia and the Iran-Iraq border region.
  const copy = structuredClone(usgs);
  const moved = [
    [138.12, 36.58, "12 km SW of Nagano, Japan"],
    [16.7, -22.9, "48 km W of Rehoboth, Namibia"],
    [45.9, 34.9, "Iran-Iraq border region"],
  ] as const;
  moved.forEach(([lon, lat, place], i) => {
    copy.features[i + 2].geometry.coordinates = [lon, lat, 10];
    copy.features[i + 2].properties.place = place;
  });
  const rows = parseUsgs(usgsSource, copy);
  const country = (place: string) =>
    rows.find((r) => r.source_geo?.name === place)?.source_geo?.country;
  assert.equal(country("208 km WNW of Port-Olry, Vanuatu"), null);
  assert.equal(country("49 km NW of Toyah, Texas"), "US");
  assert.equal(country("12 km SW of Nagano, Japan"), "JP");
  assert.equal(country("48 km W of Rehoboth, Namibia"), "NA");
  assert.equal(country("Iran-Iraq border region"), null);
  assert.equal(country("39 km W of Mosteiros, Portugal"), null);
  assert.match(record(rows[0]).notice, /left empty offshore or near a coast or border/);
});

/** A GDACS page of `count` current events, cloned from a real current earthquake record. */
const gdacsPage = (count: number, first = 0) => ({
  ...gdacs,
  features: Array.from({ length: count }, (_, i) => {
    const feature = structuredClone(gdacs.features[3]);
    feature.properties.eventid = 2000000 + first + i;
    return feature;
  }),
});
async function collectGdacs(
  pages: Record<string, unknown>,
  options: { maxRequests?: number; source?: SourceRecord } = {},
) {
  const requested: string[] = [];
  const accepted: ObservationInput[] = [];
  const reconciled: string[][] = [];
  const health: { error: string | null }[] = [];
  const results = await collectSources(
    {
      EW_API_URL: "https://isolated.invalid",
      EW_COLLECTOR_TOKEN: "isolated-fixture",
    },
    {
      sources: [options.source ?? gdacsSource],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async (_, h) => {
        health.push(h);
      },
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      fetch: async (url, init) => {
        requested.push(String(url));
        if (String(url).endsWith("/reconcile")) {
          reconciled.push(JSON.parse(String(init?.body)).active_native_ids);
          return Response.json({ changed: 0, more: false });
        }
        const page = pages[String(url)];
        return page === undefined
          ? new Response(null, { status: 204 })
          : Response.json(page);
      },
      maxRequests: options.maxRequests ?? 40,
      now: () => Date.parse("2026-10-21T18:00:00Z"),
    },
  );
  return { results, requested, accepted, reconciled, health };
}
const page = (n: number) => `${GDACS_EVENTS_URL}&pagenumber=${n}`;

test("GDACS pages past 100 events and publishes and reconciles all 101", async () => {
  const run = await collectGdacs({
    [GDACS_EVENTS_URL]: gdacsPage(100),
    [page(2)]: gdacsPage(1, 100),
  });
  assert.deepEqual(run.requested.slice(0, 2), [GDACS_EVENTS_URL, page(2)]);
  assert.deepEqual(
    run.results.map((r) => [r.status, r.received]),
    [["ok", 101]],
  );
  assert.equal(new Set(run.accepted.map((o) => o.native_id)).size, 101);
  assert.equal(run.reconciled.length, 1);
  assert.equal(run.reconciled[0].length, 101);
  // Exactly 100 events: GDACS answers the next page with 204 No Content.
  const exact = await collectGdacs({ [GDACS_EVENTS_URL]: gdacsPage(100) });
  assert.deepEqual(exact.requested.slice(0, 2), [GDACS_EVENTS_URL, page(2)]);
  assert.equal(exact.results[0].received, 100);
  assert.equal(exact.reconciled[0].length, 100);
  // An event updated between page requests can move pages; it is published once.
  const shifted = await collectGdacs({
    [GDACS_EVENTS_URL]: gdacsPage(100),
    [page(2)]: gdacsPage(2, 99),
  });
  assert.equal(shifted.results[0].received, 101);
});

test("an unfinished GDACS paging run publishes and reconciles nothing", async () => {
  const full = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [
      n === 1 ? GDACS_EVENTS_URL : page(n),
      gdacsPage(100, n * 100),
    ]),
  );
  const capped = await collectGdacs(full);
  assert.equal(capped.requested.length, 3);
  assert.deepEqual(capped.results[0].status, "error");
  assert.equal(capped.results[0].error, "gdacs_source_page_budget");
  assert.equal(capped.accepted.length, 0);
  assert.equal(capped.reconciled.length, 0);
  // The run-wide request budget stops paging even when the source allows more pages.
  const exhausted = await collectGdacs(full, {
    maxRequests: 6,
    source: {
      ...gdacsSource,
      config: { ...gdacsSource.config, max_pages: 10 },
    },
  });
  assert.equal(exhausted.requested.length, 6);
  assert.equal(exhausted.results[0].error, "collector_request_budget");
  assert.equal(exhausted.accepted.length, 0);
  assert.equal(exhausted.reconciled.length, 0);
  assert.equal(exhausted.health.at(-1)?.error, "collector_request_budget");
});

test("a GDACS event stays live while listed as current, however old, and ends without cancellation when GDACS stops listing it", async () => {
  const s = fixtureServer();
  try {
    const day = 86400000;
    let clock = Date.now();
    // GDACS writes UTC without a zone designator.
    const gdacsTime = (ms: number) => new Date(ms).toISOString().slice(0, 19);
    const listed = structuredClone(gdacs);
    const tc = listed.features.find(
      (f: any) => f.properties.eventid === 1001338,
    );
    tc.properties.fromdate = gdacsTime(clock - 10 * day);
    tc.properties.todate = gdacsTime(clock - 3 * day);
    tc.properties.datemodified = gdacsTime(clock - 3 * day);
    const withdrawn = {
      ...listed,
      features: listed.features.filter((f: any) => f !== tc),
    };
    const checkpoints = new Map<string, any>();
    const run = (payload: unknown) =>
      collectSources(
        {
          EW_API_URL: "https://isolated.invalid",
          EW_COLLECTOR_TOKEN: "isolated-fixture",
        },
        {
          sources: [gdacsSource],
          register: (sources) =>
            s.api("/api/sources", { sources }, "fixture-collector"),
          checkpoint: async (id) => checkpoints.get(id) ?? {},
          recordHealth: async (id, h) => {
            checkpoints.set(id, h.checkpoint);
          },
          request: async (path, body) => {
            const r = await s.api(path, body, "fixture-collector");
            if (r.status !== 200) throw Error(`fixture_api_${r.status}`);
            return r.body;
          },
          fetch: async () => Response.json(payload),
          now: () => clock,
        },
      );
    const live = async () =>
      ((await s.api("/api/snapshot?hours=24&include_incoming=0")).body
        .incidents as IncidentView[]).map((i) => i.headline);
    const champi = "Tropical Cyclone CHAMPI-26";
    await s.api("/api/alert-rules", { id: "severe", rule: { impacts: ["severe"] } });

    assert.equal((await run(listed))[0].received, 6);
    assert.deepEqual((await live()).sort(), listed.features.map((f: any) => f.properties.name).sort());

    clock += 11 * 60000;
    assert.equal((await run(withdrawn))[0].status, "ok");
    assert.deepEqual((await live()).sort(), withdrawn.features.map((f: any) => f.properties.name).sort());
    const ended = ((await s.api("/api/snapshot?include_incoming=0")).body
      .incidents as IncidentView[]).find((i) => i.headline === champi)!;
    assert.equal(ended.version, 2);
    assert.equal(ended.current_listing, false);
    assert.equal(ended.cancelled, false);
    assert.equal(ended.evidence_status, "official_advisory");
    assert.equal(ended.impact, "severe");
    assert.ok(Date.parse(ended.expires_at!) <= Date.now());
    assert.deepEqual(
      { ...s.db.prepare("SELECT reason FROM incident_revisions WHERE incident_id=? AND version=2").get(ended.id) },
      { reason: "issuer no longer lists the event as current" },
    );
    assert.equal(
      s.db.prepare("SELECT count(*) AS n FROM outbox WHERE entity_id=? AND event_type='incident.updated'").get(ended.id)?.n,
      1,
    );
    // An ended event cannot raise an urgent alert.
    assert.deepEqual(
      { ...s.db.prepare("SELECT state,reason FROM alert_deliveries WHERE incident_id=? AND incident_version=2").get(ended.id) },
      { state: "suppressed", reason: "expired" },
    );

    // A further complete read changes nothing, and a new episode brings the event back.
    clock += 11 * 60000;
    await run(withdrawn);
    tc.properties.episodeid = 30;
    clock += 11 * 60000;
    await run(listed);
    const back = ((await s.api("/api/snapshot?hours=24&include_incoming=0")).body
      .incidents as IncidentView[]).find((i) => i.headline === champi)!;
    assert.equal(back.version, 3);
    assert.equal(back.current_listing, true);
    assert.equal(back.expires_at, null);
  } finally {
    s.db.close();
  }
});
