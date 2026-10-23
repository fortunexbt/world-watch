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
  emscQueryURL,
  parseEmsc,
  EMSC_LIMIT,
  EMSC_QUERY_URL,
} from "../src/collector/adapters/emsc.js";
import {
  parseGdacs,
  GDACS_IMPACT,
  GDACS_EVENTS_URL,
} from "../src/collector/adapters/gdacs.js";
import {
  parseNws,
  NWS_IMPACT,
  NWS_ALERTS_URL,
} from "../src/collector/adapters/nws.js";
import {
  parseEccc,
  ECCC_IMPACT,
  ECCC_ALERTS_URL,
} from "../src/collector/adapters/eccc.js";
import {
  parseAdsbLol,
  SQUAWK,
  ADSBLOL_SQUAWK_URL,
} from "../src/collector/adapters/adsblol.js";
import {
  parseAwcSigmets,
  AWC_LIMIT,
  AWC_SIGMET_URL,
} from "../src/collector/adapters/awc.js";
import {
  parseEasaCzibs,
  EASA_CZIB_URL,
  EASA_CZIB_TEXT_URL,
} from "../src/collector/adapters/easa.js";
import { csv } from "../src/collector/csv.js";
import { polygonArea } from "../src/collector/adapters/area.js";
import {
  parseRipestatRouting,
  RIPESTAT_ROUTING_URL,
  ROUTING_COUNTRIES,
  routingImpact,
  routingURL,
} from "../src/collector/adapters/ripestat.js";
import { checkedURL } from "../src/collector/fetch.js";
import { countryAt } from "../src/shared/borders.js";
import { incidentInWindow } from "../src/shared/temporal.js";
import { PUBLIC_SOURCES } from "../src/public/snapshot.js";
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
// The real EMSC answer of 23 October 2026 for M4.5+ from 2026-10-20T17:38 to 2026-10-21T17:38,
// the USGS fixture's day, kept whole.
const emsc = JSON.parse(readFileSync("tests/fixtures/emsc-events.json", "utf8"));
const emscSource = sourceRegistry.find((s) => s.id === "global-emsc-earthquakes")!;
// Trimmed from api.weather.gov on 2026-10-22: the active storm-based warnings query, the past
// week's tornado and severe thunderstorm messages for their cancellations, and one test message,
// zone-only watch and unlinked statement from the unfiltered active list.
const nws = JSON.parse(readFileSync("tests/fixtures/nws-alerts.json", "utf8"));
const nwsSource = sourceRegistry.find((s) => s.id === "us-nws-warnings")!;
// Trimmed from api.weather.gc.ca on 2026-10-22: five of the eleven warnings, plus an ended fog
// advisory and a special weather statement from the unfiltered list; the match count is the trimmed one.
const eccc = JSON.parse(readFileSync("tests/fixtures/eccc-alerts.json", "utf8"));
const ecccSource = sourceRegistry.find((s) => s.id === "ca-eccc-warnings")!;
// Trimmed from api.adsb.lol on 2026-10-22: seven aircraft from a 1200,7000 squawk query, chosen for a
// live ADS-B fix, a multilateration fix, an aircraft on the ground, a lastPosition fix inside and one
// outside the five-minute limit, a Mode S aircraft with no position and a 7000 squawk. Registrations
// are removed and the total is the trimmed one. The emergency query listed no aircraft while the
// fixture was taken, so emergency codes, privacy flags and failures are set on clones below.
const adsb = JSON.parse(
  readFileSync("tests/fixtures/adsblol-aircraft.json", "utf8"),
);
const adsbSource = sourceRegistry.find(
  (s) => s.id === "global-adsblol-emergency-squawks",
)!;
/** The fixture with every aircraft, or the listed ones, squawking a code. */
function squawking(code: string, hexes?: string[], payload = adsb) {
  const copy = structuredClone(payload);
  copy.ac = copy.ac.filter((a: any) => !hexes || hexes.includes(a.hex));
  for (const a of copy.ac) a.squawk = code;
  copy.total = copy.ac.length;
  return copy;
}
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

test("EMSC events keep the unid, revision clock, origin ID, magnitude type, depth, region and solution author with no invented impact", () => {
  const rows = parseEmsc(emscSource, emsc);
  assert.equal(rows.length, 19);
  const vanuatu = byId(rows, "20261021_0000241");
  assert.equal(vanuatu.source_event_id, "20261021_0000241");
  assert.equal(vanuatu.title, "M 4.9 - VANUATU");
  assert.equal(
    vanuatu.canonical_url,
    "https://www.seismicportal.eu/eventdetails.html?unid=20261021_0000241",
  );
  assert.equal(vanuatu.published_at, null);
  assert.equal(vanuatu.source_updated_at, "2026-10-21T17:00:56.957Z");
  assert.equal(vanuatu.official?.effective_at, "2026-10-21T15:22:33.566Z");
  assert.equal(vanuatu.official?.activity, "earthquake");
  assert.equal(vanuatu.official?.impact, "unknown");
  assert.equal(vanuatu.official?.issuer, "European-Mediterranean Seismological Centre");
  assert.deepEqual(vanuatu.source_geo, {
    lon: 165.3793,
    lat: -14.1338,
    name: "VANUATU",
    accuracy: "point",
    country: null,
  });
  assert.deepEqual(record(vanuatu), {
    magnitude: 4.9,
    magnitude_type: "mb",
    place: "VANUATU",
    origin_time: "2026-10-21T15:22:33.566Z",
    source_updated_at: "2026-10-21T17:00:56.957Z",
    depth_km: 10,
    event_type: "known earthquake",
    author: "NEIC",
    origin_id: "2078202",
    catalogue: "EMSC-RTS",
    notice: record(vanuatu).notice,
  });
  assert.match(record(vanuatu).notice, /NEIC is the USGS National Earthquake Information Center/);
  assert.match(record(vanuatu).notice, /CC BY 4\.0, credit EMSC-CSEM SeismicPortal/);
  const azores = byId(rows, "20261020_0000263");
  assert.equal(record(azores).author, "EMSC");
  assert.equal(record(azores).magnitude_type, "mw");
  // Depth is positive kilometres, as in EMSC's properties, not the negative third coordinate.
  assert.equal(record(byId(rows, "20261020_0000346")).depth_km, 519.4);
  assert.equal(record(byId(rows, "20261021_0000146")).author, "UNA");
  // EMSC names a region, not a country; the country comes from the map's boundaries, as for USGS.
  assert.equal(byId(rows, "20261021_0000012").source_geo?.country, "JP");
  assert.equal(byId(rows, "20261021_0000205").source_geo?.country, null, "Hokkaido's offshore epicentre keeps no country");
  assert.equal(
    rows.filter((r) => record(r).author === "NEIC").length,
    4,
    "four of the day's solutions are NEIC's, republished",
  );
});

test("EMSC non-earthquake types, missing points and truncated or invalid lists never become guessed events", () => {
  const copy = structuredClone(emsc);
  copy.features[0].properties.evtype = "kx";
  copy.features[1].geometry = null;
  copy.features[2].properties.evtype = "se";
  copy.features[3].properties.mag = null;
  const rows = parseEmsc(emscSource, copy);
  assert.equal(rows.length, 18);
  assert(!rows.some((r) => r.native_id === copy.features[0].id));
  assert.equal(byId(rows, copy.features[1].id).source_geo, undefined);
  assert.equal(record(byId(rows, copy.features[2].id)).event_type, "suspected earthquake");
  assert.equal(byId(rows, copy.features[3].id).title, "Earthquake - HOKKAIDO, JAPAN REGION");
  assert.throws(
    () => parseEmsc(emscSource, { ...emsc, metadata: { count: 20 } }),
    /emsc_feed_truncated/,
  );
  const full = {
    ...emsc,
    metadata: { count: EMSC_LIMIT },
    features: Array.from({ length: EMSC_LIMIT }, () => emsc.features[0]),
  };
  assert.throws(() => parseEmsc(emscSource, full), /emsc_feed_truncated/, "a full page may hide older events");
  assert.throws(() => parseEmsc(emscSource, { error: 1 }), /invalid_emsc_response/);
});

test("EMSC is read for the past day from the minute at M4.5 through an approved host, and an empty day is a clean read", async () => {
  const at = Date.parse("2026-10-21T17:38:42Z");
  assert.equal(
    emscQueryURL(at),
    EMSC_QUERY_URL +
      "?format=json&starttime=2026-10-20T17%3A38%3A00&minmag=4.5&orderby=time&limit=" +
      EMSC_LIMIT,
  );
  assert.equal(checkedURL(emscQueryURL(at)).hostname, "www.seismicportal.eu");
  assert.deepEqual(emscSource.countries, ["*"]);
  assert.equal(emscSource.rights.ai, false);
  assert.equal(emscSource.config.operational_role, "structured_natural_hazard");
  assert.match(emscSource.rights.attribution, /^Credit: EMSC-CSEM SeismicPortal, https:\/\/www\.seismicportal\.eu/);
  for (const [body, received] of [
    [Response.json(emsc), 19],
    [new Response(null, { status: 204 }), 0],
  ] as const) {
    const requested: string[] = [];
    const accepted: ObservationInput[] = [];
    const results = await collectSources(
      {
        EW_API_URL: "https://isolated.invalid",
        EW_COLLECTOR_TOKEN: "isolated-fixture",
      },
      {
        sources: [emscSource],
        register: async () => {},
        checkpoint: async () => ({}),
        recordHealth: async () => {},
        ingest: async (rows) => {
          accepted.push(...rows);
        },
        fetch: async (url) => {
          requested.push(String(url));
          return body.clone();
        },
        maxRequests: 40,
        now: () => at,
      },
    );
    // EMSC is a rolling window like USGS, so nothing is reconciled.
    assert.deepEqual(requested, [emscQueryURL(at)]);
    assert.deepEqual(
      results.map((r) => [r.source_id, r.status, r.received]),
      [[emscSource.id, "ok", received]],
    );
    assert(
      accepted.every(
        (x) => x.eligibility?.reason === "structured_natural_hazard_record",
      ),
    );
  }
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
  // Each changed cyclone episode also reads its geometry; no fixture quake qualifies for a ShakeMap read.
  assert.deepEqual(requested, [
    USGS_FEED_URL,
    GDACS_EVENTS_URL,
    "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=1001341&episodeid=1",
    "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=1001338&episodeid=29",
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
  options: {
    maxRequests?: number;
    source?: SourceRecord;
    /** Milliseconds a URL takes to answer, or until the request is aborted. */
    delays?: Record<string, number>;
    timeoutMs?: number;
  } = {},
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
        const delay = options.delays?.[String(url)];
        if (delay)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(init.signal!.reason);
            });
          });
        const page = pages[String(url)];
        return page === undefined
          ? new Response(null, { status: 204 })
          : Response.json(page);
      },
      maxRequests: options.maxRequests ?? 40,
      timeoutMs: options.timeoutMs,
      now: () => Date.parse("2026-10-21T18:00:00Z"),
    },
  );
  return { results, requested, accepted, reconciled, health };
}
const page = (n: number) => `${GDACS_EVENTS_URL}&pagenumber=${n}`;

test("GDACS waits for its own measured timeout on every page, and other sources keep the collector's", async () => {
  // GDACS answered in 1.6 to 74.9 s, so it waits longer than the 15 s fetch default, which stays as it was.
  assert.equal(gdacsSource.config.timeout_ms, 90000);
  assert.equal(usgsSource.config.timeout_ms, undefined);
  const scaled = (ms: number) => ({ ...gdacsSource, config: { ...gdacsSource.config, timeout_ms: ms } });
  const listed = { [GDACS_EVENTS_URL]: gdacsPage(1) };
  const slow = { [GDACS_EVENTS_URL]: 150 };
  assert.deepEqual(
    (await collectGdacs(listed, { source: scaled(1000), delays: slow, timeoutMs: 30 })).results.map((r) => r.status),
    ["ok"],
    "the source's timeout overrides a shorter collector timeout",
  );
  const late = await collectGdacs(listed, { source: scaled(30), delays: slow, timeoutMs: 1000 });
  assert.equal(late.results[0].status, "error");
  assert.equal(late.accepted.length, 0);
  const paged = await collectGdacs(
    { [GDACS_EVENTS_URL]: gdacsPage(100), [page(2)]: gdacsPage(1, 100) },
    { source: scaled(30), delays: { [page(2)]: 150 }, timeoutMs: 1000 },
  );
  assert.equal(paged.results[0].status, "error", "later pages wait no longer than the first");
  assert.equal(paged.reconciled.length, 0);
  const { timeout_ms, ...config } = gdacsSource.config;
  assert.equal(
    (await collectGdacs(listed, { source: { ...gdacsSource, config }, delays: slow, timeoutMs: 30 })).results[0].status,
    "error",
    "without its own value a source keeps the collector's timeout",
  );
});

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

test("NWS warnings keep the VTEC event as identity, the latest message as revision and the polygon as a labelled area", () => {
  const rows = parseNws(nwsSource, nws);
  // A repeated flood warning collapses to one event; the test message, zone-only watch and statement without VTEC are dropped.
  assert.deepEqual(
    rows.map((r) => r.native_id),
    [
      "KFGZ.SV.W.0202.2026",
      "KSLC.FF.W.0154.2026",
      "KMLB.FL.W.0003.2026",
      "KGJT.FA.W.0008.2026",
      "KFGZ.TO.W.0012.2026",
      "KFGZ.SV.W.0201.2026",
    ],
  );
  const storm = byId(rows, "KFGZ.SV.W.0202.2026");
  assert.equal(storm.source_event_id, storm.native_id);
  assert.equal(
    storm.canonical_url,
    "https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.2fcc7e3f79c5056c446c86c78ad5929c296d4d9c.001.1",
  );
  assert.equal(
    storm.title,
    "Severe Thunderstorm Warning issued October 22 at 11:09AM MST until October 22 at 11:15AM MST by NWS Flagstaff AZ",
  );
  // The warning dates from its first message, which the update references.
  assert.equal(storm.official?.effective_at, "2026-10-22T17:54:00.000Z");
  assert.equal(storm.published_at, "2026-10-22T18:09:00.000Z");
  assert.equal(storm.official?.expires_at, "2026-10-22T18:15:00.000Z");
  assert.equal(storm.official?.activity, "severe_weather");
  assert.equal(storm.official?.impact, "significant");
  assert.equal(storm.official?.cancelled, false);
  const geo = storm.source_geo!;
  assert.equal(geo.accuracy, "area");
  assert.equal(geo.country, "US");
  assert.equal(geo.name, "Navajo, AZ");
  assert(Math.abs(geo.lon - -110.29) < 1e-9 && Math.abs(geo.lat - 34.48) < 1e-9);
  assert(geo.radius_km! > 15 && geo.radius_km! < 16);
  const excerpt = record(storm);
  assert.equal(excerpt.vtec_action, "CON");
  assert.equal(excerpt.maxHailSize, "1.00");
  assert.match(excerpt.description, /Quarter size hail/);
  assert.match(excerpt.notice, /reproduced unchanged/);
  assert.match(excerpt.notice, /wider than the warned area/);
  const flash = byId(rows, "KSLC.FF.W.0154.2026");
  assert.equal(flash.official?.activity, "flood");
  assert.equal(record(flash).flashFloodDamageThreat, "CONSIDERABLE");
  // A river flood warning with no stated end lasts until its message expires.
  assert.equal(
    byId(rows, "KMLB.FL.W.0003.2026").official?.expires_at,
    "2026-10-23T15:00:00.000Z",
  );
});

test("an NWS cancellation is the latest revision of its warning, and CAP severity maps one step down and never to critical", () => {
  const rows = parseNws(nwsSource, nws);
  const tornado = byId(rows, "KFGZ.TO.W.0012.2026");
  assert.equal(tornado.title, "The Tornado Warning has been cancelled.");
  assert.equal(tornado.official?.cancelled, true);
  assert.equal(tornado.official?.message_type, "Cancel");
  assert.equal(tornado.official?.impact, "informational");
  assert.equal(tornado.official?.effective_at, "2026-10-22T16:30:00.000Z");
  const issued = structuredClone(nws);
  issued.features = issued.features.filter(
    (f: any) => f.properties.messageType !== "Cancel",
  );
  const live = byId(parseNws(nwsSource, issued), "KFGZ.TO.W.0012.2026");
  assert.equal(live.official?.cancelled, false);
  assert.equal(live.official?.impact, "severe");
  assert.equal(record(live).tornadoDetection, "RADAR INDICATED");
  for (const [severity, impact] of Object.entries(NWS_IMPACT)) {
    const copy = structuredClone(nws);
    copy.features[0].properties.severity = severity;
    assert.equal(parseNws(nwsSource, copy)[0].official?.impact, impact);
  }
  assert.equal(NWS_IMPACT.Extreme, "severe");
  const odd = structuredClone(nws);
  odd.features[0].properties.severity = "Unknown";
  // Test-class VTEC and a December first message both change what is admitted or identified.
  odd.features[1].properties.parameters.VTEC = [
    "/T.EXT.KSLC.FF.W.0154.000000T0000Z-261022T2145Z/",
  ];
  odd.features[2].properties.references[0].sent = "2025-12-31T12:00:00-04:00";
  const oddRows = parseNws(nwsSource, odd);
  assert.equal(oddRows[0].official?.impact, "unknown");
  assert(!oddRows.some((r) => r.native_id.startsWith("KSLC.FF.W.0154")));
  assert(oddRows.some((r) => r.native_id === "KMLB.FL.W.0003.2025"));
  assert.throws(() => parseNws(nwsSource, { features: {} }), /invalid_nws_response/);
});

test("polygon areas unwrap the 180° line and cover every part of a multipolygon", () => {
  const fiji = polygonArea({
    type: "Polygon",
    coordinates: [[[179.5, -17], [-179.5, -17], [-179.5, -16], [179.5, -16], [179.5, -17]]],
  })!;
  assert.equal(fiji.lon, 180);
  assert.equal(fiji.lat, -16.5);
  assert(fiji.radius_km < 100);
  const pair = polygonArea({
    type: "MultiPolygon",
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 0]]],
      [[[3, 0], [4, 0], [4, 1], [3, 0]]],
    ],
  })!;
  assert.equal(pair.lon, 2);
  assert(pair.radius_km > 220);
  assert.equal(polygonArea({ type: "Point", coordinates: [0, 0] }), null);
  assert.equal(
    polygonArea({ type: "Polygon", coordinates: [[[0, 0], [200, 0], [0, 1]]] }),
    null,
  );
});

test("NWS collection asks for GeoJSON from the approved host and admits warnings as structured hazard records", async () => {
  assert.deepEqual(nwsSource.countries, ["US", "PR", "GU", "AS", "VI", "MP"]);
  assert.equal(nwsSource.rights.ai, false);
  assert.equal(nwsSource.rights.redistribute, true);
  assert(configuredRegistry({ countries: ["PR"] }).includes(nwsSource));
  assert(!configuredRegistry({ countries: ["IT"] }).includes(nwsSource));
  const accepted: ObservationInput[] = [];
  const requests: [string, string | null][] = [];
  const results = await collectSources(
    {
      EW_API_URL: "https://isolated.invalid",
      EW_COLLECTOR_TOKEN: "isolated-fixture",
    },
    {
      sources: [nwsSource],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async () => {},
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      fetch: async (url, init) => {
        requests.push([
          String(url),
          new Headers(init?.headers).get("accept"),
        ]);
        return new Response(JSON.stringify(nws), {
          headers: { "content-type": "application/geo+json" },
        });
      },
      maxRequests: 40,
      now: () => Date.parse("2026-10-22T18:10:00Z"),
    },
  );
  assert.deepEqual(requests, [[NWS_ALERTS_URL, "application/geo+json"]]);
  assert.deepEqual(
    results.map((r) => [r.source_id, r.status, r.received]),
    [["us-nws-warnings", "ok", 6]],
  );
  assert(
    accepted.every(
      (x) => x.eligibility?.reason === "structured_natural_hazard_record",
    ),
  );
});

test("NWS warnings publish without analysis, and a later cancellation revises the same incident", async () => {
  const s = fixtureServer();
  try {
    assert.equal(
      (await s.api("/api/sources", { sources: [nwsSource] }, "fixture-collector"))
        .status,
      200,
    );
    const issued = structuredClone(nws);
    issued.features = issued.features.filter(
      (f: any) => f.properties.messageType !== "Cancel",
    );
    const ingest = async (rows: ObservationInput[]) => {
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
    };
    await ingest(parseNws(nwsSource, issued));
    let incidents: IncidentView[] = (await s.api("/api/snapshot")).body
      .incidents;
    assert.equal(incidents.length, 5);
    const tornado = () =>
      incidents.find((i) => i.location?.name === "Yavapai, AZ")!;
    assert.equal(tornado().activity, "severe_weather");
    assert.equal(tornado().impact, "severe");
    assert.equal(tornado().cancelled, false);
    assert.equal(tornado().location?.accuracy, "area");
    assert.equal(tornado().location?.country, "US");
    assert(tornado().location!.radius_km > 10);
    assert.equal(tornado().expires_at, "2026-10-22T17:00:00.000Z");
    const flood = incidents.find((i) => i.headline.startsWith("Flash Flood"))!;
    assert.equal(flood.activity, "flood");
    assert.equal(flood.impact, "significant");
    await ingest(parseNws(nwsSource, nws));
    incidents = (await s.api("/api/snapshot")).body.incidents;
    assert.equal(incidents.length, 6);
    assert.equal(tornado().cancelled, true);
    assert.equal(tornado().version, 2);
    assert.equal(tornado().headline, "The Tornado Warning has been cancelled.");
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
  } finally {
    s.db.close();
  }
});

test("ECCC warnings keep ECCC's per-region alert ID, bilingual text unchanged and the region as a labelled area", () => {
  const rows = parseEccc(ecccSource, eccc);
  // The ended fog advisory and the special weather statement are not warnings.
  assert.equal(rows.length, 5);
  const wind = byId(rows, "190122771851897148202610210501_fea1-2532");
  const feature = eccc.features[0].properties;
  assert.equal(wind.source_event_id, wind.native_id);
  assert.equal(
    wind.canonical_url,
    "https://api.weather.gc.ca/collections/weather-alerts/items/190122771851897148202610210501_fea1-2532",
  );
  assert.equal(wind.title, "Wind warning, Resolute");
  assert.equal(wind.published_at, "2026-10-22T08:42:16.793Z");
  assert.equal(wind.official?.effective_at, "2026-10-22T16:00:00.000Z");
  assert.equal(wind.official?.expires_at, "2026-10-23T01:00:00.000Z");
  assert.equal(wind.official?.activity, "severe_weather");
  assert.equal(wind.official?.impact, "minor");
  assert.equal(wind.official?.cancelled, false);
  assert.equal(wind.source_geo?.accuracy, "area");
  assert.equal(wind.source_geo?.country, "CA");
  assert.equal(wind.source_geo?.name, "Resolute");
  assert(wind.source_geo!.radius_km! > 40 && wind.source_geo!.radius_km! < 42);
  const excerpt = record(wind);
  assert.equal(excerpt.text_en, feature.alert_text_en.trim());
  assert.equal(excerpt.text_fr, feature.alert_text_fr.trim());
  assert.equal(excerpt.status, "continued");
  assert.equal(excerpt.impact, "Moderate");
  assert.match(excerpt.notice, /reproduced unchanged/);
  // A blizzard warning for the same region is a separate ECCC alert.
  const blizzard = byId(rows, "185815178851897148202610210501_fea1-2532");
  assert.equal(blizzard.title, "Blizzard warning, Resolute");
  assert.deepEqual(blizzard.source_geo, wind.source_geo);
});

test("ECCC colour maps to impact without reaching critical, an ended warning is cancelled and a short page fails visibly", () => {
  for (const [colour, impact] of Object.entries(ECCC_IMPACT)) {
    const copy = structuredClone(eccc);
    copy.features[0].properties.risk_colour_en = colour;
    assert.equal(parseEccc(ecccSource, copy)[0].official?.impact, impact);
  }
  assert.equal(ECCC_IMPACT.red, "severe");
  const variants = structuredClone(eccc);
  variants.features[0].properties.risk_colour_en = null;
  variants.features[1].properties.alert_name_en = "hurricane warning";
  variants.features[2].properties.alert_name_en = "storm surge warning";
  variants.features[3].properties.status_en = "ended";
  variants.features[4].geometry = null;
  const rows = parseEccc(ecccSource, variants);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].official?.impact, "unknown");
  assert.equal(rows[1].official?.activity, "tropical_cyclone");
  assert.equal(rows[2].official?.activity, "flood");
  assert.equal(rows[3].official?.cancelled, true);
  assert.throws(
    () => parseEccc(ecccSource, { ...eccc, numberMatched: 8 }),
    /eccc_pagination_required/,
  );
  assert.throws(() => parseEccc(ecccSource, { features: {} }), /invalid_eccc_response/);
});

test("ECCC's byte cap holds a full page of warnings at the sizes seen live and in the fixture", () => {
  const cap = Number(ecccSource.config.max_bytes);
  // A live read on 23 October 2026: 295 warnings in 2,240,665 bytes. One page holds 500.
  assert.ok(cap >= (2_240_665 / 295) * 500 * 1.5, "half again over a full page at the live size");
  const fixture = Buffer.byteLength(readFileSync("tests/fixtures/eccc-alerts.json", "utf8"));
  assert.ok(cap >= (fixture / eccc.features.length) * 500 * 1.5);
});

test("ECCC collection reads the approved warnings query and admits warnings as structured hazard records", async () => {
  assert.deepEqual(ecccSource.countries, ["CA"]);
  assert.equal(ecccSource.rights.ai, false);
  assert.match(
    ecccSource.rights.attribution,
    /^Data Source: Environment and Climate Change Canada\./,
  );
  const accepted: ObservationInput[] = [];
  const requested: string[] = [];
  const results = await collectSources(
    {
      EW_API_URL: "https://isolated.invalid",
      EW_COLLECTOR_TOKEN: "isolated-fixture",
    },
    {
      sources: [ecccSource],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async () => {},
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      fetch: async (url) => {
        requested.push(String(url));
        return Response.json(eccc);
      },
      maxRequests: 40,
      now: () => Date.parse("2026-10-22T18:10:00Z"),
    },
  );
  assert.deepEqual(requested, [ECCC_ALERTS_URL]);
  assert.deepEqual(
    results.map((r) => [r.source_id, r.status, r.received]),
    [["ca-eccc-warnings", "ok", 5]],
  );
  assert(
    accepted.every(
      (x) => x.eligibility?.reason === "structured_natural_hazard_record",
    ),
  );
});

test("ECCC warnings publish without analysis, and ECCC ending a warning revises the same incident", async () => {
  const s = fixtureServer();
  try {
    assert.equal(
      (await s.api("/api/sources", { sources: [ecccSource] }, "fixture-collector"))
        .status,
      200,
    );
    const ingest = async (rows: ObservationInput[]) => {
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
    };
    await ingest(parseEccc(ecccSource, eccc));
    let incidents: IncidentView[] = (await s.api("/api/snapshot")).body
      .incidents;
    assert.equal(incidents.length, 5);
    const wind = () =>
      incidents.find((i) => i.headline === "Wind warning, Resolute")!;
    assert.equal(wind().activity, "severe_weather");
    assert.equal(wind().impact, "minor");
    assert.equal(wind().location?.country, "CA");
    assert.equal(wind().location?.accuracy, "area");
    assert.equal(wind().expires_at, "2026-10-23T01:00:00.000Z");
    assert.equal(
      wind().reports[0].rights.attribution,
      ecccSource.rights.attribution,
    );
    const ended = structuredClone(eccc);
    ended.features[0].properties.status_en = "ended";
    ended.features[0].properties.publication_datetime =
      "2026-10-22T20:00:00.000Z";
    await ingest(parseEccc(ecccSource, ended).slice(0, 1));
    incidents = (await s.api("/api/snapshot")).body.incidents;
    assert.equal(incidents.length, 5);
    assert.equal(wind().cancelled, true);
    assert.equal(wind().version, 2);
    assert.deepEqual(
      s.db
        .prepare("SELECT DISTINCT state,error_kind FROM analysis_jobs")
        .all()
        .map((r) => ({ ...r })),
      [{ state: "blocked", error_kind: "rights" }],
    );
  } finally {
    s.db.close();
  }
});

test("ADSB.lol squawks keep the aircraft, code and first-seen minute as identity and the last received fix as a point", () => {
  // 1200 and 7000 are not emergency codes.
  assert.deepEqual(parseAdsbLol(adsbSource, adsb), []);
  const rows = parseAdsbLol(adsbSource, squawking("7700"));
  assert.deepEqual(
    rows.map((r) => r.native_id),
    adsb.ac.map((a: any) => `${a.hex}.7700.2026-10-22T23:38Z`),
  );
  const ken = byId(rows, "ac7aaa.7700.2026-10-22T23:38Z");
  assert.equal(ken.source_event_id, ken.native_id);
  assert.equal(ken.title, "KEN1212 squawking 7700, general emergency");
  assert.equal(ken.canonical_url, "https://adsb.lol/?icao=ac7aaa");
  assert.equal(ken.published_at, null);
  assert.equal(ken.source_updated_at, "2026-10-22T23:38:56.501Z");
  assert.deepEqual(record(ken), {
    hex: "ac7aaa",
    callsign: "KEN1212",
    squawk: "7700",
    squawk_meaning: "general emergency",
    emergency_status: "none",
    aircraft_type: "C208",
    military: false,
    on_ground: false,
    altitude_ft: 2275,
    ground_speed_kt: 154.9,
    track_deg: 313.17,
    vertical_rate_fpm: -576,
    position_source: "adsb_icao",
    position_at: "2026-10-22T23:38:56.477Z",
    first_seen: "2026-10-22T23:38:00.000Z",
    notice: record(ken).notice,
  });
  assert.match(record(ken).notice, /no authority has confirmed/);
  assert.match(record(ken).notice, /Open Database License \(ODbL\) 1\.0/);
  // Near the Canadian border, so no country is derived.
  assert.deepEqual(ken.source_geo, {
    lon: -122.912222,
    lat: 48.411804,
    name: "KEN1212 reported position",
    accuracy: "point",
    radius_km: 1,
    country: null,
  });
  assert.deepEqual(ken.official, {
    issuer: "ADSB.lol",
    effective_at: "2026-10-22T23:38:00.000Z",
    expires_at: null,
    current_listing: true,
    self_reported: true,
    activity: "aviation_emergency",
    impact: "minor",
  });
  const mlat = byId(rows, "a83cf0.7700.2026-10-22T23:38Z");
  assert.equal(record(mlat).position_source, "mlat");
  assert.equal(mlat.source_geo?.country, "US");
  const ground = byId(rows, "a81490.7700.2026-10-22T23:38Z");
  assert.equal(record(ground).on_ground, true);
  assert.equal(record(ground).altitude_ft, null);
  // A Mode S aircraft's last fix, 69 seconds old, with no ground speed: the radius assumes cruise speed.
  const last = byId(rows, "7cc4f6.7700.2026-10-22T23:38Z");
  assert.deepEqual(last.source_geo, {
    lon: 145.000649,
    lat: -37.238811,
    name: "R8852 reported position",
    accuracy: "point",
    radius_km: 17.7,
    country: "AU",
  });
  assert.equal(record(last).position_at, "2026-10-22T23:37:47.502Z");
  // A 23-minute-old fix and an aircraft with no position are kept for continuity but not mapped.
  for (const id of ["7c79fd", "abc759"]) {
    const row = byId(rows, id + ".7700.2026-10-22T23:38Z");
    assert.equal(row.source_geo, undefined);
    assert.equal(record(row).position_at, null);
  }
  assert.equal(byId(rows, "44ba76.7700.2026-10-22T23:38Z").source_geo?.country, null);
  // Registration and owner fields never reach the record.
  const owned = squawking("7700", ["ac7aaa"]);
  Object.assign(owned.ac[0], { r: "N12345", ownOp: "Fixture Owner LLC", year: "1999" });
  assert.deepEqual(record(parseAdsbLol(adsbSource, owned)[0]), record(ken));
});

test("squawk impact stays low and never severe, privacy-flagged aircraft are skipped and a short or invalid response fails", () => {
  assert.deepEqual(SQUAWK, {
    "7500": { meaning: "unlawful interference", impact: "significant" },
    "7600": { meaning: "radio failure", impact: "informational" },
    "7700": { meaning: "general emergency", impact: "minor" },
  });
  for (const code of Object.keys(SQUAWK)) {
    const [row] = parseAdsbLol(adsbSource, squawking(code, ["ac7aaa"]));
    assert.equal(row.official?.impact, SQUAWK[code as keyof typeof SQUAWK].impact);
    assert.equal(row.title, `KEN1212 squawking ${code}, ${SQUAWK[code as keyof typeof SQUAWK].meaning}`);
    assert(!["severe", "critical"].includes(row.official!.impact!));
  }
  // Privacy ICAO Address and LADD aircraft are dropped; the military flag is kept as a field.
  const flagged = squawking("7700", ["ac7aaa", "a83cf0", "a81490"]);
  flagged.ac[0].dbFlags = 4;
  flagged.ac[1].dbFlags = 8;
  flagged.ac[2].dbFlags = 1;
  const kept = parseAdsbLol(adsbSource, flagged);
  assert.deepEqual(kept.map((r) => r.native_id), ["a81490.7700.2026-10-22T23:38Z"]);
  assert.equal(record(kept[0]).military, true);
  // Malformed addresses are dropped and a repeated aircraft is published once.
  const odd = squawking("7700", ["ac7aaa", "a83cf0"]);
  odd.ac[1].hex = "not-hex";
  odd.ac.push(structuredClone(odd.ac[0]));
  odd.total = 3;
  assert.deepEqual(
    parseAdsbLol(adsbSource, odd).map((r) => r.native_id),
    ["ac7aaa.7700.2026-10-22T23:38Z"],
  );
  const short = squawking("7700");
  short.total = 8;
  assert.throws(() => parseAdsbLol(adsbSource, short), /adsblol_response_truncated/);
  assert.throws(() => parseAdsbLol(adsbSource, { msg: "No error" }), /invalid_adsblol_response/);
  assert.throws(() => parseAdsbLol(adsbSource, { ...adsb, now: "soon" }), /invalid_adsblol_response/);
});

test("a squawk episode keeps its ID and start while listed, and a new code or a later sighting opens another", () => {
  const first = parseAdsbLol(adsbSource, squawking("7700", ["ac7aaa"]));
  const moved = squawking("7700", ["ac7aaa"]);
  moved.now += 10 * 60000;
  moved.ac[0].lat += 0.2;
  const active = first.map((r) => r.native_id);
  const [later] = parseAdsbLol(adsbSource, moved, active);
  assert.equal(later.native_id, "ac7aaa.7700.2026-10-22T23:38Z");
  assert.equal(later.official?.effective_at, "2026-10-22T23:38:00.000Z");
  assert.equal(later.source_geo?.lat, 48.611804);
  assert.equal(later.source_updated_at, "2026-10-22T23:48:56.501Z");
  // Not listed by the previous complete read: a new episode starting now.
  assert.equal(
    parseAdsbLol(adsbSource, moved)[0].native_id,
    "ac7aaa.7700.2026-10-22T23:48Z",
  );
  // Another code from the same aircraft is another episode.
  const radio = squawking("7600", ["ac7aaa"], moved);
  assert.equal(
    parseAdsbLol(adsbSource, radio, active)[0].native_id,
    "ac7aaa.7600.2026-10-22T23:48Z",
  );
  assert.equal(
    parseAdsbLol(adsbSource, moved, ["ac7aaa.7700.unknown"])[0].native_id,
    "ac7aaa.7700.2026-10-22T23:48Z",
  );
});

test("ADSB.lol collection reads one approved query, carries episodes forward and reconciles the complete list", async () => {
  assert.deepEqual(adsbSource.countries, ["*"]);
  assert.equal(adsbSource.rights.ai, false);
  assert.equal(adsbSource.rights.redistribute, true);
  assert.match(adsbSource.rights.attribution, /Open Database License \(ODbL\) 1\.0/);
  assert(configuredRegistry({ countries: ["IT"] }).includes(adsbSource));
  const checkpoints = new Map<string, any>();
  const accepted: ObservationInput[] = [];
  const requested: string[] = [];
  const reconciled: unknown[] = [];
  // The fetch layer stamps success with the wall clock, so the run clock starts there.
  let clock = Date.now();
  let payload = squawking("7700", ["ac7aaa", "a83cf0"]);
  const run = () =>
    collectSources(
      {
        EW_API_URL: "https://isolated.invalid",
        EW_COLLECTOR_TOKEN: "isolated-fixture",
      },
      {
        sources: [adsbSource],
        register: async () => {},
        checkpoint: async (id) => checkpoints.get(id) ?? {},
        recordHealth: async (id, h) => {
          checkpoints.set(id, h.checkpoint);
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
          return Response.json(payload);
        },
        maxRequests: 40,
        now: () => clock,
      },
    );
  assert.deepEqual(
    (await run()).map((r) => [r.source_id, r.status, r.received]),
    [["global-adsblol-emergency-squawks", "ok", 2]],
  );
  assert.deepEqual(requested, [
    ADSBLOL_SQUAWK_URL,
    "https://isolated.invalid/api/sources/global-adsblol-emergency-squawks/reconcile",
  ]);
  assert(
    accepted.every(
      (x) => x.eligibility?.reason === "self_reported_transponder_emergency_code",
    ),
  );
  // One poll on, one aircraft has moved and the other has cleared its code.
  clock += 6 * 60000;
  payload = squawking("7700", ["ac7aaa"]);
  payload.now += 6 * 60000;
  payload.ac[0].lat += 0.1;
  accepted.length = 0;
  await run();
  assert.deepEqual(accepted.map((o) => o.native_id), ["ac7aaa.7700.2026-10-22T23:38Z"]);
  assert.deepEqual(reconciled, [
    ["ac7aaa.7700.2026-10-22T23:38Z", "a83cf0.7700.2026-10-22T23:38Z"],
    ["ac7aaa.7700.2026-10-22T23:38Z"],
  ]);
  // An empty list is still a complete read, and it ends every episode.
  clock += 6 * 60000;
  payload = squawking("7700", []);
  await run();
  assert.deepEqual(reconciled.at(-1), []);
});

test("emergency squawks publish unverified without analysis, revise as the aircraft moves and end without cancellation when the code clears", async () => {
  const s = fixtureServer();
  try {
    let clock = Date.now();
    const checkpoints = new Map<string, any>();
    const response = (
      codes: Record<string, string>,
      moved: Record<string, number> = {},
    ) => {
      const copy = structuredClone(adsb);
      copy.ac = copy.ac.filter((a: any) => codes[a.hex]);
      for (const a of copy.ac) {
        a.squawk = codes[a.hex];
        a.lat += moved[a.hex] ?? 0;
      }
      copy.total = copy.ac.length;
      copy.now = clock;
      return copy;
    };
    let payload = response({ ac7aaa: "7700", a83cf0: "7600", a81490: "7500" });
    const run = () =>
      collectSources(
        {
          EW_API_URL: "https://isolated.invalid",
          EW_COLLECTOR_TOKEN: "isolated-fixture",
        },
        {
          sources: [adsbSource],
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
    const incidents = async () =>
      (await s.api("/api/snapshot?hours=24&include_incoming=0")).body
        .incidents as IncidentView[];
    const find = (list: IncidentView[], callsign: string) =>
      list.find((i) => i.headline.startsWith(callsign + " "))!;
    await s.api("/api/alert-rules", { id: "any", rule: { allow_unverified: true } });

    assert.equal((await run())[0].received, 3);
    let live = await incidents();
    assert.equal(live.length, 3);
    for (const i of live) {
      assert.equal(i.activity, "aviation_emergency");
      assert.equal(i.evidence_status, "unverified");
      assert.equal(i.current_listing, true);
      assert.equal(i.location?.accuracy, "point");
      assert.equal(i.reports[0].rights.attribution, adsbSource.rights.attribution);
    }
    assert.deepEqual(
      ["KEN1212", "REH91", "STT62"].map((c) => find(live, c).impact),
      ["minor", "informational", "significant"],
    );
    // No analysis worker has connected, so the brief is built from the records alone.
    assert.equal(
      (await s.api("/api/brief?hours=24")).body.current.headline,
      "1 aircraft reported squawking 7500 (unlawful interference). 1 aircraft reported squawking 7700 (general emergency). 1 aircraft reported squawking 7600 (radio failure).",
    );
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

    // One poll on, STT62 has moved, REH91 has cleared 7600 and KEN1212 is listed again where it was.
    const before = find(live, "STT62");
    clock += 6 * 60000;
    payload = response({ ac7aaa: "7700", a81490: "7500" }, { a81490: 0.1 });
    await run();
    live = await incidents();
    const hijack = find(live, "STT62");
    assert.equal(hijack.id, before.id);
    assert.equal(hijack.version, 2);
    assert.ok(Math.abs(hijack.location!.lat - 42.826299) < 1e-9);
    assert.equal(hijack.event_start, before.event_start);
    // A new response time is a new fix time, so every listed aircraft revises.
    assert.equal(find(live, "KEN1212").version, 2);
    assert.equal(find(live, "KEN1212").location?.lat, 48.411804);
    // Not official and not severe: no urgent alert, even for a rule that accepts unverified records.
    assert.deepEqual(
      { ...s.db.prepare("SELECT state,reason FROM alert_deliveries WHERE incident_id=? AND incident_version=2").get(hijack.id) },
      { state: "suppressed", reason: "no_current_urgent_claim" },
    );
    const cleared = find(live, "REH91");
    assert.equal(cleared.version, 2);
    assert.equal(cleared.current_listing, false);
    assert.equal(cleared.cancelled, false);
    assert.equal(cleared.evidence_status, "unverified");
    assert.ok(Date.parse(cleared.expires_at!) <= Date.now());
    // Exports carry the records with their ODbL notice, as the licence's share-alike asks.
    const exported = (await s.api("/api/export")).body;
    assert.equal(exported.incidents.length, 3);
    assert.equal(exported.excluded_for_rights, 0);
    assert(exported.incidents.every((i: IncidentView) => /ODbL/.test(i.reports[0].rights.attribution)));
  } finally {
    s.db.close();
  }
});

// Trimmed from stat.ripe.net on 2026-10-23: hourly country-resource-stats for Syria's shutdown of
// 29 November 2012, Iran's of 16 November 2019 and Syria's last 14 days. Drops and recoveries the
// recent window lacks are written into clones of it hour by hour, never into the fixture file.
const routing = JSON.parse(
  readFileSync("tests/fixtures/ripestat-routing.json", "utf8"),
);
const routingSource = sourceRegistry.find(
  (s) => s.id === "global-ripestat-routing",
)!;
const HOUR = 3600000;
const hourISO = (ms: number) => new Date(ms).toISOString().slice(0, 19);
/** The real recent response as one row per hour, ending at `end`, each hour's counts open to edit. */
function routingHours(
  country: string,
  end: number,
  edit: (row: any, index: number, count: number) => void = () => {},
) {
  const real = structuredClone(routing["sy-now"]);
  const rows = real.data.stats
    .flatMap((row: any) =>
      row.timeline.flatMap((t: any) => {
        const out = [];
        for (
          let at = Date.parse(t.starttime + "Z");
          at <= Date.parse(t.endtime + "Z");
          at += HOUR
        )
          out.push({ ...row, at });
        return out;
      }),
    )
    .sort((a: any, b: any) => a.at - b.at)
    .map(({ at, ...row }: any, i: number, all: any[]) => ({
      ...row,
      timeline: [
        {
          starttime: hourISO(end - (all.length - 1 - i) * HOUR),
          endtime: hourISO(end - (all.length - 1 - i) * HOUR),
        },
      ],
    }));
  rows.forEach((row: any, i: number) => edit(row, i, rows.length));
  return {
    ...real,
    data: { ...real.data, resource: country.toLowerCase(), stats: rows },
  };
}
const shutdown =
  (from: number, to = 0) =>
  (row: any, i: number, n: number) => {
    if (i >= n - from && i < n - to) {
      row.v4_prefixes_ris = 0;
      row.asns_ris = 0;
    }
  };
const routingEnd = Date.parse("2026-10-22T21:00:00Z");

test("a real national shutdown becomes one routing drop with native hour identity, a country area and an end at the measured recovery", () => {
  const sy = parseRipestatRouting(
    routingSource,
    "SY",
    routing["sy-2012"],
    Date.parse("2012-12-01T17:30:00Z"),
  )!;
  assert.equal(sy.length, 1);
  const [drop] = sy;
  assert.equal(drop.native_id, "SY-2012-11-29T10");
  assert.equal(drop.source_event_id, drop.native_id);
  assert.equal(drop.title, "Internet routing visibility drop, Syria");
  assert.equal(drop.official?.activity, "connectivity_disruption");
  assert.equal(drop.official?.impact, "severe");
  assert.equal(drop.official?.effective_at, "2012-11-29T10:00:00.000Z");
  assert.equal(drop.official?.expires_at, "2012-12-01T15:00:00.000Z");
  assert.equal(drop.official?.current_listing, undefined);
  assert.equal(drop.published_at, null);
  // The area comes from the map's own Syria polygon, not a guessed point.
  const geo = drop.source_geo!;
  assert.deepEqual(
    [geo.name, geo.accuracy, geo.country, countryAt(geo.lon, geo.lat)],
    ["Syria", "area", "SY", "SY"],
  );
  assert(geo.radius_km! > 300 && geo.radius_km! < 500);
  const r = record(drop);
  assert.equal(r.baseline_ipv4_prefixes, 73);
  assert.equal(r.lowest_ipv4_prefixes, 0);
  assert.equal(r.largest_drop_percent, 100);
  assert.equal(r.drop_started, "2012-11-29T10:00:00.000Z");
  assert.equal(r.low_until, "2012-12-01T14:00:00.000Z");
  assert.equal(r.recovered_at, "2012-12-01T15:00:00.000Z");
  assert.match(r.notice, /not a confirmed shutdown and states no cause/);
  assert.equal(
    drop.canonical_url,
    `${RIPESTAT_ROUTING_URL}?resource=sy&starttime=2012-11-26T10%3A00&endtime=2012-12-01T16%3A00&resolution=1h`,
  );
  // Iran lost about half its prefixes and a third of its networks: significant, from the native counts.
  const [ir] = parseRipestatRouting(
    routingSource,
    "IR",
    routing["ir-2019"],
    Date.parse("2019-11-21T14:00:00Z"),
  )!;
  assert.equal(ir.native_id, "IR-2019-11-16T20");
  assert.equal(ir.official?.impact, "significant");
  assert.equal(ir.official?.expires_at, "2019-11-21T11:00:00.000Z");
  assert.deepEqual(
    [record(ir).baseline_ipv4_prefixes, record(ir).baseline_asns, record(ir).largest_drop_percent],
    [6098, 441, 53],
  );
  // Syria's last fourteen days hold no drop.
  assert.deepEqual(
    parseRipestatRouting(routingSource, "SY", routing["sy-now"], routingEnd + HOUR),
    [],
  );
  for (const drop of [0.25, 0.49, 0.5, 0.89, 0.9, 1])
    assert.notEqual(routingImpact(drop), "critical");
  assert.deepEqual(
    [0.25, 0.5, 0.9, 1].map(routingImpact),
    ["minor", "significant", "severe", "severe"],
  );
});

test("a routing drop needs two low hours, lost networks unless half the prefixes go, a country of 50 prefixes and current data", () => {
  const parse = (payload: unknown, now = routingEnd + HOUR) =>
    parseRipestatRouting(routingSource, "SY", payload, now);
  // A synthetic shutdown three hours old is open: live as current, no expiry.
  const [open] = parse(routingHours("SY", routingEnd, shutdown(3)))!;
  assert.equal(open.native_id, `SY-${hourISO(routingEnd - 2 * HOUR).slice(0, 13)}`);
  assert.equal(open.official?.current_listing, true);
  assert.equal(open.official?.expires_at, null);
  assert.equal(open.official?.impact, "severe");
  assert.equal(record(open).recovered_at, null);
  assert.equal(record(open).low_until, new Date(routingEnd).toISOString());
  // One low hour is not a drop.
  assert.deepEqual(parse(routingHours("SY", routingEnd, shutdown(1))), []);
  // Two recovered hours end it at the first of them; one recovered hour does not.
  const [ended] = parse(routingHours("SY", routingEnd, shutdown(5, 2)))!;
  assert.equal(ended.native_id, open.native_id.replace(/T\d\d$/, "T" + hourISO(routingEnd - 4 * HOUR).slice(11, 13)));
  assert.equal(ended.official?.expires_at, new Date(routingEnd - HOUR).toISOString());
  assert.equal(ended.official?.current_listing, undefined);
  const [blip] = parse(routingHours("SY", routingEnd, (row, i, n) => {
    if (i >= n - 5 && i !== n - 2) row.v4_prefixes_ris = row.asns_ris = 0;
  }))!;
  assert.equal(blip.official?.current_listing, true);
  // A third of the prefixes gone with every network still routed reads as aggregation, not a drop;
  // losing one of eight networks as well makes it a minor drop.
  const partial = (asns: number) =>
    routingHours("SY", routingEnd, (row, i, n) => {
      if (i >= n - 3) {
        row.v4_prefixes_ris = 340;
        row.asns_ris = asns;
      }
    });
  assert.deepEqual(parse(partial(8)), []);
  assert.equal(parse(partial(7))![0].official?.impact, "minor");
  // Half the prefixes are a drop on their own.
  const half = routingHours("SY", routingEnd, (row, i, n) => {
    if (i >= n - 3) row.v4_prefixes_ris = 250;
  });
  assert.equal(parse(half)![0].official?.impact, "significant");
  // A country routing fewer than 50 prefixes is never evaluated.
  const small = routingHours("SY", routingEnd, (row, i, n) => {
    row.v4_prefixes_ris = i >= n - 3 ? 0 : 40;
  });
  assert.deepEqual(parse(small), []);
  // Missing hours are skipped, never read as low.
  const gap = routingHours("SY", routingEnd);
  gap.data.stats.splice(-6, 4);
  assert.deepEqual(parse(gap), []);
  // Data more than six hours old can neither open nor end a drop.
  assert.equal(parse(routingHours("SY", routingEnd, shutdown(3)), routingEnd + 7 * HOUR), null);
  assert.equal(parse({ ...routing["sy-now"], data: { ...routing["sy-now"].data, stats: [] } }), null);
  // A response for another country, at another resolution or not ok fails visibly.
  assert.throws(() => parseRipestatRouting(routingSource, "IR", routing["sy-now"], routingEnd), /invalid_ripestat_response/);
  for (const broken of [
    { ...routing["sy-now"], status: "error" },
    { ...routing["sy-now"], data: { ...routing["sy-now"].data, resolution: "5m" } },
    { ...routing["sy-now"], data: { ...routing["sy-now"].data, stats: null } },
  ])
    assert.throws(() => parse(broken), /invalid_ripestat_response/);
});

test("a long routing drop stays one record against the baseline before it, and leaves tracking after seven days", () => {
  const parse = (payload: unknown) =>
    parseRipestatRouting(routingSource, "SY", payload, routingEnd + HOUR)!;
  // Five days low: the low hours never become their own baseline, so it is still one open drop.
  const long = parse(routingHours("SY", routingEnd, shutdown(5 * 24)));
  assert.equal(long.length, 1);
  assert.equal(long[0].official?.current_listing, true);
  assert.equal(record(long[0]).baseline_ipv4_prefixes, 521);
  // A drop that started more than seven days before the latest hour is no longer reported.
  const old = parse(routingHours("SY", routingEnd, shutdown(8 * 24, 7 * 24 + 10)));
  assert.deepEqual(old, []);
});

test("the routing source asks RIPEstat for three countries a poll in turn, keeps other countries' open drops listed and reconciles only when one goes", async () => {
  assert.deepEqual(routingSource.countries, ["*"]);
  assert.equal(routingSource.rights.ai, false);
  assert.equal(routingSource.rights.display, true);
  assert.equal(routingSource.rights.redistribute, false);
  assert.match(routingSource.rights.attribution, /https:\/\/www\.ripe\.net\/ris/);
  assert.match(routingSource.rights.attribution, /The RIPE Routing Information Service \(RIS\) is a RIPE NCC service\./);
  assert.equal(checkedURL(routingURL("IR", routingEnd)).hostname, "stat.ripe.net");
  assert.equal(
    routingURL("IR", Date.parse("2026-10-23T00:01:57Z")),
    `${RIPESTAT_ROUTING_URL}?resource=ir&starttime=2026-10-09T00%3A00&resolution=1h&sourceapp=world-watch`,
  );
  assert.equal(ROUTING_COUNTRIES.length, 175);
  const [a, b, c, d] = ROUTING_COUNTRIES;
  const now = routingEnd + HOUR;
  const run = async (
    checkpoint: any,
    payloads: Record<string, unknown>,
  ) => {
    const requested: string[] = [];
    const accepted: ObservationInput[] = [];
    const reconciled: string[][] = [];
    let saved: any;
    const results = await collectSources(
      { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "isolated-fixture" },
      {
        sources: [routingSource],
        register: async () => {},
        checkpoint: async () => checkpoint,
        recordHealth: async (_, h) => {
          saved = h.checkpoint;
        },
        ingest: async (rows) => {
          accepted.push(...rows);
        },
        fetch: async (url, init) => {
          requested.push(String(url));
          if (String(url).endsWith("/reconcile")) {
            reconciled.push(JSON.parse(String(init?.body)).active_native_ids);
            return Response.json({ changed: 1, more: false });
          }
          const country = new URL(String(url)).searchParams.get("resource")!.toUpperCase();
          return Response.json(payloads[country] ?? routingHours(country, routingEnd));
        },
        maxRequests: 40,
        now: () => now,
      },
    );
    return { results, requested, accepted, reconciled, saved };
  };
  const first = await run({}, { [b]: routingHours(b, routingEnd, shutdown(3)) });
  assert.deepEqual(first.requested, [a, b, c].map((x) => routingURL(x, now)));
  assert.deepEqual(first.results.map((r) => [r.status, r.received]), [["ok", 1]]);
  assert.equal(first.accepted[0].eligibility?.reason, "structured_measurement_record");
  const opened = first.accepted[0].native_id;
  assert.deepEqual(first.saved.routing, { next: 3, ongoing: [opened] });
  assert.deepEqual(first.reconciled, []);
  // The next poll reads the next three countries and keeps the drop it did not re-read listed.
  const next = await run(
    { ...first.saved, last_success_at: undefined },
    {},
  );
  assert.deepEqual(next.requested, ROUTING_COUNTRIES.slice(3, 6).map((x) => routingURL(x, now)));
  assert.deepEqual(next.saved.routing, { next: 6, ongoing: [opened] });
  assert.deepEqual(next.reconciled, []);
  // Back at the drop's country, a recovered record ends it and the open set empties.
  const recovered = await run(
    { routing: { next: 0, ongoing: [opened] } },
    { [b]: routingHours(b, routingEnd, shutdown(5, 2)) },
  );
  assert.equal(recovered.accepted.length, 1);
  assert.equal(recovered.accepted[0].native_id, opened.replace(/T\d\d$/, "T" + hourISO(routingEnd - 4 * HOUR).slice(11, 13)));
  assert.deepEqual(recovered.saved.routing.ongoing, []);
  assert.deepEqual(recovered.reconciled, [[]]);
  // A drop that is simply no longer found is ended by reconciliation, while other countries' drops stay listed.
  const elsewhere = `${d}-2026-10-22T18`;
  const vanished = await run({ routing: { next: 0, ongoing: [opened, elsewhere] } }, {});
  assert.equal(vanished.accepted.length, 0);
  assert.deepEqual(vanished.reconciled, [[elsewhere]]);
  // Lagging data leaves the country's open drop exactly as it was.
  const stale = await run(
    { routing: { next: 0, ongoing: [opened] } },
    { [b]: routingHours(b, routingEnd - 8 * HOUR) },
  );
  assert.deepEqual(stale.saved.routing, { next: 3, ongoing: [opened] });
  assert.deepEqual(stale.reconciled, []);
  // Rotation wraps after the last country.
  const wrap = await run({ routing: { next: 174, ongoing: [] } }, {});
  assert.deepEqual(wrap.requested, [ROUTING_COUNTRIES[174], a, b].map((x) => routingURL(x, now)));
  assert.equal(wrap.saved.routing.next, 2);
  // A failed request publishes nothing and keeps the rotation where it was.
  const failed = await run({ routing: { next: 0, ongoing: [opened] } }, { [c]: { status: "error" } });
  assert.equal(failed.results[0].status, "error");
  assert.equal(failed.accepted.length, 0);
  assert.deepEqual(failed.saved.routing, { next: 0, ongoing: [opened] });
});

test("a routing drop publishes live without analysis, ends at the measured recovery, and one no longer found is ended by reconciliation", async () => {
  const s = fixtureServer();
  try {
    // The server judges liveness by its own clock, so the hours end before now.
    const end = Math.floor(Date.now() / HOUR) * HOUR - 14 * HOUR;
    const [, country] = ROUTING_COUNTRIES;
    let checkpoint: any = {};
    const run = (latest: number, edit?: (row: any, i: number, n: number) => void) =>
      collectSources(
        { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "isolated-fixture" },
        {
          sources: [routingSource],
          register: (sources) => s.api("/api/sources", { sources }, "fixture-collector"),
          // Each poll starts back at the drop's country.
          checkpoint: async () => ({ routing: { next: 0, ongoing: [] }, ...checkpoint, last_success_at: undefined }),
          recordHealth: async (_, h) => {
            checkpoint = { ...h.checkpoint, routing: { ...h.checkpoint.routing!, next: 0 } };
          },
          request: async (path, body) => {
            const r = await s.api(path, body, "fixture-collector");
            if (r.status !== 200) throw Error(`fixture_api_${r.status}`);
            return r.body;
          },
          fetch: async (url) => {
            const c = new URL(String(url)).searchParams.get("resource")!.toUpperCase();
            return Response.json(routingHours(c, latest, c === country ? edit : undefined));
          },
          now: () => latest + HOUR,
        },
      );
    const snapshot = async () =>
      (await s.api("/api/snapshot?hours=24&include_incoming=0")).body
        .incidents as IncidentView[];
    await s.api("/api/alert-rules", { id: "severe", rule: { impacts: ["severe"] } });

    assert.equal((await run(end, shutdown(3)))[0].received, 1);
    let [drop] = await snapshot();
    assert.equal(drop.activity, "connectivity_disruption");
    assert.equal(drop.impact, "severe");
    assert.equal(drop.current_listing, true);
    assert.equal(drop.expires_at, null);
    assert.equal(drop.analyzed_at, null);
    assert.equal(drop.location?.country, country);
    assert.equal(drop.location?.accuracy, "area");
    assert.equal(drop.event_start, new Date(end - 2 * HOUR).toISOString());
    assert.equal(drop.reports[0].rights.redistribute, false);
    assert.deepEqual(
      s.db.prepare("SELECT DISTINCT state,error_kind FROM analysis_jobs").all().map((r) => ({ ...r })),
      [{ state: "blocked", error_kind: "rights" }],
    );

    // Five hours on, the country has recovered: the same incident ends at the first recovered hour.
    await run(end + 5 * HOUR, shutdown(8, 3));
    [drop] = await snapshot();
    assert.equal(drop.version, 2);
    assert.equal(drop.current_listing, undefined);
    assert.equal(drop.expires_at, new Date(end + 3 * HOUR).toISOString());
    assert.equal(drop.cancelled, false);
    // The rule that was alerted to the open severe drop hears that it ended; no new urgent alert fires.
    assert.deepEqual(
      s.db
        .prepare("SELECT incident_version,state,reason FROM alert_deliveries WHERE incident_id=? ORDER BY incident_version")
        .all(drop.id)
        .map((r) => ({ ...r })),
      [
        { incident_version: 1, state: "eligible_ui", reason: "broad_area_notice; location uncertainty overlaps watch area" },
        {
          incident_version: 2,
          state: "eligible_ui",
          reason: "correction_or_retraction; notify prior eligible recipient (current eligibility changed: expired)",
        },
      ],
    );

    // A drop that leaves the measurement without a recovered record is ended by reconciliation.
    await run(end + 10 * HOUR, shutdown(3));
    const reopened = (await snapshot()).find((i) => i.current_listing)!;
    assert.notEqual(reopened.id, drop.id);
    assert.deepEqual(checkpoint.routing.ongoing, [`${country}-${hourISO(end + 8 * HOUR).slice(0, 13)}`]);
    await run(end + 12 * HOUR);
    const gone = (await snapshot()).find((i) => i.id === reopened.id)!;
    assert.equal(gone.current_listing, false);
    assert.ok(Date.parse(gone.expires_at!) <= Date.now());
    assert.deepEqual(
      { ...s.db.prepare("SELECT reason FROM incident_revisions WHERE incident_id=? ORDER BY version DESC").get(gone.id) },
      { reason: "measured drop no longer found open" },
    );
    assert.deepEqual(checkpoint.routing.ongoing, []);
  } finally {
    s.db.close();
  }
});

// The real AWC answer for ash SIGMETs valid at 2026-09-28T00:00Z, reduced to the three entries
// issued by the NWS Alaska Aviation Weather Unit (PAWU): KILO 3's observed and forecast clouds and
// KILO 2's forecast cloud. The other fifteen came from foreign watch offices, whose SIGMETs this
// public repository does not republish.
const awc = JSON.parse(readFileSync("tests/fixtures/awc-sigmets.json", "utf8"));
const awcSource = sourceRegistry.find(
  (s) => s.id === "global-awc-volcanic-ash-sigmets",
)!;
// EASA's JSON and CSV exports of the bulletin list, both fetched on 2026-10-23 and kept whole.
const czibList = JSON.parse(
  readFileSync("tests/fixtures/easa-czibs.json", "utf8"),
);
const czibText = readFileSync("tests/fixtures/easa-czibs.csv", "utf8");
const easaSource = sourceRegistry.find(
  (s) => s.id === "global-easa-conflict-zone-bulletins",
)!;
const km = (a: { lon: number; lat: number }, lon: number, lat: number) =>
  111.32 *
  Math.hypot(
    ((((lon - a.lon) % 360) + 540) % 360 - 180) *
      Math.cos((a.lat * Math.PI) / 180),
    lat - a.lat,
  );

test("AWC ash SIGMETs are one record per SIGMET with both clouds, the issuer's validity, levels and text unchanged", () => {
  const rows = parseAwcSigmets(awcSource, awc);
  assert.deepEqual(
    rows.map((r) => r.native_id),
    ["PAWU-KILO2-20260927T1812", "PAWU-KILO3-20260927T2145"],
  );
  const kilo3 = byId(rows, "PAWU-KILO3-20260927T2145");
  const fields = record(kilo3);
  assert.equal(kilo3.source_event_id, kilo3.native_id);
  assert.equal(
    kilo3.title,
    "Volcanic ash SIGMET KILO 3 from PAWU: SHEVELUCH, PAZA ANCHORAGE",
  );
  // AWC lists the observed and forecast clouds of KILO 3 as two entries with one message.
  assert.deepEqual(fields.parts, ["FCST", "OBS"]);
  assert.equal(fields.sigmet, awc[2].rawSigmet);
  assert.equal(fields.volcano, "SHEVELUCH");
  assert.equal(fields.public_domain, true);
  assert.equal(fields.levels, "SFC/FL380");
  assert.equal(fields.top_feet, 38000);
  assert.equal(fields.issued, "2026-09-27T21:45:00.000Z");
  assert.equal(kilo3.published_at, "2026-09-27T21:45:40.126Z");
  assert.equal(kilo3.official?.effective_at, "2026-09-27T21:45:00.000Z");
  assert.equal(kilo3.official?.expires_at, "2026-09-28T03:45:00.000Z");
  assert.equal(kilo3.official?.activity, "volcanic_ash");
  assert.equal(kilo3.official?.impact, "minor");
  assert.equal(kilo3.official?.cancelled, undefined);
  assert.equal(kilo3.official?.self_reported, undefined);
  // AWC writes the forecast cloud east of 180° as longitudes up to 187°; the area spans both clouds.
  const g = kilo3.source_geo!;
  assert.equal(g.accuracy, "area");
  assert(Math.abs(g.lon) <= 180);
  for (const part of awc.slice(1))
    for (const p of part.coords)
      assert(km(g, p.lon, p.lat) <= g.radius_km! + 0.01);
  assert.match(fields.notice, /cancelled early stays until its stated end/);
  // A record ends at its stated time, so it leaves the live window then.
  const view = {
    event_start: kilo3.official!.effective_at,
    published_at: kilo3.published_at,
    expires_at: kilo3.official!.expires_at,
  };
  assert(incidentInWindow(view, 1, Date.parse("2026-09-28T03:44:00Z")));
  assert(!incidentInWindow(view, 1, Date.parse("2026-09-28T03:46:00Z")));
});

test("AWC entries that are not ash, lack an area or arrive in a truncated or invalid list never become guessed SIGMETs", () => {
  const variants = structuredClone(awc);
  variants[0].hazard = "TS";
  variants[1].geom = "LINE";
  delete variants[2].base;
  delete variants[2].top;
  const rows = parseAwcSigmets(awcSource, variants);
  // KILO 2 is a thunderstorm now, and KILO 3 keeps the cloud that still has an area.
  assert.deepEqual(rows.map((r) => r.native_id), ["PAWU-KILO3-20260927T2145"]);
  assert.deepEqual(record(rows[0]).parts, ["OBS"]);
  assert.equal(record(rows[0]).levels, null);
  // Tokyo names a volcano with its caldera in brackets.
  const named = structuredClone(awc);
  for (const part of named)
    part.rawSigmet = part.rawSigmet.replace("MT SHEVELUCH", "MT SAKURAJIMA (AIRA CALDERA)");
  assert.equal(
    record(byId(parseAwcSigmets(awcSource, named), "PAWU-KILO3-20260927T2145")).volcano,
    "SAKURAJIMA (AIRA CALDERA)",
  );
  assert.throws(
    () => parseAwcSigmets(awcSource, Array(AWC_LIMIT).fill(awc[0])),
    /awc_sigmet_list_truncated/,
  );
  assert.throws(
    () => parseAwcSigmets(awcSource, { features: [] }),
    /invalid_awc_response/,
  );
});

test("AWC is read through one approved query, an empty list is a clean read and foreign SIGMETs stay out of public output", async () => {
  assert.equal(checkedURL(AWC_SIGMET_URL).hostname, "aviationweather.gov");
  assert.equal(awcSource.rights.display, true);
  assert.equal(awcSource.rights.redistribute, false);
  assert.equal(awcSource.rights.ai, false);
  assert.equal(awcSource.config.operational_role, "structured_aviation_advisory");
  assert.match(String(awcSource.config.unresolved_permission), /third-party information/);
  assert(!PUBLIC_SOURCES.some((s) => s.id === awcSource.id));
  for (const [body, received] of [
    [Response.json(awc), 2],
    [new Response(null, { status: 204 }), 0],
  ] as const) {
    const requested: string[] = [];
    const accepted: ObservationInput[] = [];
    const results = await collectSources(
      {
        EW_API_URL: "https://isolated.invalid",
        EW_COLLECTOR_TOKEN: "isolated-fixture",
      },
      {
        sources: [awcSource],
        register: async () => {},
        checkpoint: async () => ({}),
        recordHealth: async () => {},
        ingest: async (rows) => {
          accepted.push(...rows);
        },
        fetch: async (url) => {
          requested.push(String(url));
          return body.clone();
        },
        maxRequests: 40,
        now: () => Date.parse("2026-09-28T00:00:00Z"),
      },
    );
    // Each SIGMET states its own end, so nothing is reconciled.
    assert.deepEqual(requested, [AWC_SIGMET_URL]);
    assert.deepEqual(
      results.map((r) => [r.source_id, r.status, r.received]),
      [[awcSource.id, "ok", received]],
    );
    assert(
      accepted.every(
        (x) => x.eligibility?.reason === "structured_aviation_advisory_record",
      ),
    );
  }
});

test("EASA bulletins join both exports, keep EASA's text unchanged and map affected countries as labelled areas", () => {
  const rows = parseEasaCzibs(easaSource, czibList, czibText);
  assert.equal(rows.length, 34);
  assert.equal(rows.filter((r) => !r.official?.cancelled).length, 16);
  const saudi = byId(rows, "144230");
  const fields = record(saudi);
  const [header, ...csvRows] = csv(czibText);
  const original = Object.fromEntries(
    header.map((h, i) => [h, csvRows.find((r) => r[1] === "CZIB-2026-09-R1")![i]]),
  );
  assert.equal(saudi.source_event_id, "144230");
  assert.equal(saudi.canonical_url, "https://www.easa.europa.eu/en/node/144230");
  assert.equal(
    saudi.title,
    "EASA conflict zone bulletin CZIB-2026-09-R1: Airspace of Saudi Arabia",
  );
  assert.equal(fields.description, original.Description.trim());
  assert.equal(fields.recommendations, original["Recommendation(s)"].trim());
  assert.equal(fields.affected_airspace, original["Affected Airspace"].trim());
  assert.equal(fields.status, "Active");
  assert.equal(fields.issued, "2026-09-30");
  assert.equal(fields.valid_until, "2026-11-16");
  assert.deepEqual(fields.country_codes, ["SA"]);
  // EASA's own times: the issue date at its site's offset, the page's last update and the stated validity date.
  assert.equal(saudi.official?.effective_at, "2026-09-29T21:00:00.000Z");
  assert.equal(saudi.published_at, "2026-10-09T11:14:44.000Z");
  assert.equal(saudi.official?.expires_at, "2026-11-16T23:59:59Z");
  assert.equal(saudi.official?.activity, "conflict_zone_advisory");
  assert.equal(saudi.official?.impact, "significant");
  assert.equal(saudi.official?.cancelled, false);
  assert.equal(saudi.source_geo?.accuracy, "country");
  assert.equal(saudi.source_geo?.country, "SA");
  assert.equal(countryAt(saudi.source_geo!.lon, saudi.source_geo!.lat), "SA");
  assert(rows.every((r) => r.official?.impact === "significant"));
  // Five Gulf states are one area with no single country; Bahrain is too small for the map's borders.
  const gulf = byId(rows, "143899");
  assert.equal(gulf.source_geo?.accuracy, "area");
  assert.equal(gulf.source_geo?.country, null);
  assert.deepEqual(record(gulf).country_codes, ["BH", "KW", "QA", "OM", "AE"]);
  assert(km(gulf.source_geo!, 50.58565, 26.22787) < gulf.source_geo!.radius_km!);
  // A bulletin naming no affected country is kept without a map point.
  const venezuela = byId(rows, "142977");
  assert.equal(venezuela.source_geo, undefined);
  assert.equal(venezuela.official?.cancelled, true);
  assert.equal(byId(rows, "65355").official?.expires_at, null);
});

test("EASA exports that disagree or change shape fail visibly rather than publish a bulletin without its text", () => {
  const missing = {
    conflict_zones: czibList.conflict_zones.map((z: any, i: number) =>
      i ? z : { ...z, name: "Airspace of Atlantis" },
    ),
  };
  assert.throws(
    () => parseEasaCzibs(easaSource, missing, czibText),
    /easa_czib_exports_disagree/,
  );
  assert.throws(
    () =>
      parseEasaCzibs(
        easaSource,
        { conflict_zones: czibList.conflict_zones.slice(1) },
        czibText,
      ),
    /easa_czib_exports_disagree/,
  );
  assert.throws(
    () => parseEasaCzibs(easaSource, czibList, czibText.replace("Subject", "Title")),
    /invalid_easa_czib_export/,
  );
  assert.throws(
    () => parseEasaCzibs(easaSource, [], czibText),
    /invalid_easa_czib_export/,
  );
});

test("EASA collection reads the list and its CSV text from approved addresses and admits bulletins as aviation advisories", async () => {
  assert.equal(easaSource.rights.redistribute, true);
  assert.equal(easaSource.rights.ai, false);
  assert.equal(easaSource.poll_seconds, 3600);
  assert.match(easaSource.rights.attribution, /^Source: European Union Aviation Safety Agency/);
  assert(PUBLIC_SOURCES.some((s) => s.id === easaSource.id));
  const requested: string[] = [];
  const accepted: ObservationInput[] = [];
  const results = await collectSources(
    {
      EW_API_URL: "https://isolated.invalid",
      EW_COLLECTOR_TOKEN: "isolated-fixture",
    },
    {
      sources: [easaSource],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async () => {},
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      fetch: async (url) => {
        requested.push(String(url));
        return String(url) === EASA_CZIB_TEXT_URL
          ? new Response(czibText, {
              headers: { "content-type": "text/csv; charset=UTF-8" },
            })
          : Response.json(czibList);
      },
      maxRequests: 40,
      now: () => Date.parse("2026-10-23T11:20:00Z"),
    },
  );
  assert.deepEqual(requested, [EASA_CZIB_URL, EASA_CZIB_TEXT_URL]);
  assert.deepEqual(
    results.map((r) => [r.source_id, r.status, r.received]),
    [[easaSource.id, "ok", 34]],
  );
  assert(
    accepted.every(
      (x) => x.eligibility?.reason === "structured_aviation_advisory_record",
    ),
  );
  // Only EASA's own CSV export is accepted as CSV.
  await assert.rejects(
    collectSources(
      { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "isolated-fixture" },
      {
        sources: [{ ...easaSource, url: EASA_CZIB_URL.replace("export-json", "other") }],
        register: async () => {},
        checkpoint: async () => ({}),
        recordHealth: async () => {},
        ingest: async () => {},
        fetch: async () =>
          new Response(czibText, { headers: { "content-type": "text/csv" } }),
        maxRequests: 40,
      },
    ).then((r) => {
      if (r[0].status === "error") throw Error(r[0].error);
    }),
    /unsupported_source_mime/,
  );
});

test("EASA bulletins publish without analysis, and EASA withdrawing one revises the same incident as cancelled", async () => {
  const s = fixtureServer();
  try {
    assert.equal(
      (await s.api("/api/sources", { sources: [easaSource] }, "fixture-collector"))
        .status,
      200,
    );
    const rows = parseEasaCzibs(easaSource, czibList, czibText);
    const ukraine = byId(rows, "136057");
    assert.equal(
      (await s.api("/api/ingest", { observations: [ukraine] }, "fixture-collector"))
        .status,
      200,
    );
    let [incident]: IncidentView[] = (await s.api("/api/snapshot")).body
      .incidents;
    assert.equal(incident.activity, "conflict_zone_advisory");
    assert.equal(incident.impact, "significant");
    assert.equal(incident.evidence_status, "official_advisory");
    assert.equal(incident.location?.country, "UA");
    assert.equal(incident.location?.accuracy, "country");
    assert.equal(incident.cancelled, false);
    assert.equal(incident.reports[0].rights.attribution, easaSource.rights.attribution);
    const list = structuredClone(czibList);
    list.conflict_zones.find((z: any) => z.Nid === "136057").updated =
      '<time datetime="2026-10-30T10:00:00+02:00">2026-10-30T10:00:00+0200</time>\n';
    const text = czibText.replace(
      /(CZIB-2022-01R14,[^,]*,[^,]*,"[^"]*",)Active/,
      "$1Withdrawn",
    );
    const withdrawn = byId(parseEasaCzibs(easaSource, list, text), "136057");
    assert.equal(withdrawn.official?.cancelled, true);
    assert.equal(
      (await s.api("/api/ingest", { observations: [withdrawn] }, "fixture-collector"))
        .status,
      200,
    );
    [incident] = (await s.api("/api/snapshot")).body.incidents;
    assert.equal(incident.cancelled, true);
    assert.equal(incident.version, 2);
  } finally {
    s.db.close();
  }
});
