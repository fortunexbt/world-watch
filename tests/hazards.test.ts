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
  assert.equal(champi.official?.expires_at, "2026-10-22T12:00:00.000Z");
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

test("a full GDACS page fails visibly instead of silently dropping events", () => {
  const full = {
    ...gdacs,
    features: Array.from({ length: 100 }, () => gdacs.features[0]),
  };
  assert.throws(
    () => parseGdacs(gdacsSource, full),
    /gdacs_pagination_required/,
  );
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
        return Response.json(String(url) === USGS_FEED_URL ? usgs : gdacs);
      },
      maxRequests: 40,
      now: () => Date.parse("2026-10-21T18:00:00Z"),
    },
  );
  assert.deepEqual(requested, [USGS_FEED_URL, GDACS_EVENTS_URL]);
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
