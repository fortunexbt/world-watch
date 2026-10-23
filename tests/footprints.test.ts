import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseNws } from "../src/collector/adapters/nws.js";
import { parseEccc } from "../src/collector/adapters/eccc.js";
import { polygonArea } from "../src/collector/adapters/area.js";
import {
  parseShakeMapContours,
  parseUsgs,
  shakeMapContoursURL,
  shakeMapDetailURL,
  USGS_FEED_URL,
} from "../src/collector/adapters/usgs.js";
import {
  gdacsGeometryURL,
  parseGdacs,
  parseGdacsGeometry,
} from "../src/collector/adapters/gdacs.js";
import { collectSources } from "../src/collector/index.js";
import type { FetchState } from "../src/collector/fetch.js";
import { sourceRegistry } from "../src/collector/registry.js";
import {
  areaRing,
  buildFootprint,
  FOOTPRINT_LIMITS,
  footprintMeetsArea,
  issuerGeometry,
  shapePositions,
  validFootprint,
  type Footprint,
  type FootprintGeometry,
  type FootprintShape,
  type Position,
} from "../src/shared/footprint.js";
import type {
  IncidentView,
  ObservationInput,
} from "../src/shared/contracts.js";
import { alertDecision, intersects, reaches } from "../src/server/alerts.js";
import { intersectsArea } from "../src/client/alerts.js";
import { listView } from "../src/shared/view.js";
import { FEED_FOOTPRINT_BYTES, geojsonFeed } from "../src/server/feeds.js";
import { FEED_FILE_LIMIT } from "../src/shared/public-snapshot.js";
import server from "../src/server/index.js";
import {
  COLLECTOR,
  env,
  migrate,
  OWNER,
  sqliteD1,
  views,
} from "../scripts/synthetic.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync("tests/fixtures/" + name, "utf8"));
const source = (id: string) => sourceRegistry.find((s) => s.id === id)!;
const nwsSource = source("us-nws-warnings"),
  ecccSource = source("ca-eccc-warnings"),
  usgsSource = source("global-usgs-earthquakes"),
  gdacsSource = source("global-gdacs-alerts");
const nws = fixture("nws-alerts.json"),
  eccc = fixture("eccc-alerts.json"),
  detail = fixture("usgs-shakemap-detail.json"),
  contours = fixture("usgs-cont-mmi.json"),
  cyclone = fixture("gdacs-geometry-tc.json");
const CONTOURS_URL =
  detail.properties.products.shakemap[0].contents["download/cont_mmi.json"].url;
const GEOMETRY_URL =
  "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=1001338&episodeid=35";

const lines = (g: FootprintGeometry): Position[][] =>
  g.type === "MultiPolygon" ? g.coordinates.flat() : g.coordinates;
/** Kilometres from a position to a line, with degrees at their local length, which the stated tolerance must cover. */
function distance(p: Position, line: Position[]) {
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180),
    ky = 110.57;
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const a = line[i],
      b = line[Math.min(i + 1, line.length - 1)];
    const dx = (b[0] - a[0]) * kx,
      dy = (b[1] - a[1]) * ky,
      px = (p[0] - a[0]) * kx,
      py = (p[1] - a[1]) * ky,
      t =
        dx || dy
          ? Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
          : 0;
    best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
  }
  return best;
}
/** The largest distance from an issuer vertex to its simplified line, per shape. */
function deviation(issuer: unknown[], s: FootprintShape) {
  let most = 0;
  s.parts.forEach((part, k) => {
    const original = lines(issuerGeometry(issuer[k])!),
      simplified = lines(part.geometry);
    assert.equal(
      simplified.length,
      original.length,
      "every ring and line is kept",
    );
    original.forEach((line, n) => {
      for (const p of line) most = Math.max(most, distance(p, simplified[n]));
    });
  });
  return most;
}
function assertBounded(f: Footprint, issuer: unknown[]) {
  assert.ok(validFootprint(f));
  for (const copy of ["detail", "display"] as const) {
    const s: FootprintShape = f[copy]!;
    assert.ok(
      shapePositions(s) <= FOOTPRINT_LIMITS[copy].positions,
      copy + " ceiling",
    );
    assert.ok(s.tolerance_km >= FOOTPRINT_LIMITS[copy].tolerance_km);
    const most = deviation(issuer, s);
    assert.ok(
      most <= s.tolerance_km,
      `${copy}: ${most.toFixed(3)} km within ${s.tolerance_km} km`,
    );
  }
}

test("NWS and ECCC warnings keep their polygon as an advisory area within its stated tolerance, beside the unchanged point", () => {
  const observations = [
    ...parseNws(nwsSource, nws).map((o) => ({
      o,
      feature: nws.features.find(
        (f: any) =>
          o.canonical_url ===
          "https://api.weather.gov/alerts/" + f.properties.id,
      ),
    })),
    ...parseEccc(ecccSource, eccc).map((o) => ({
      o,
      feature: eccc.features.find((f: any) => o.native_id === f.id),
    })),
  ];
  assert.ok(observations.length >= 10);
  for (const { o, feature } of observations) {
    const f = o.footprint!;
    assert.equal(f.role, "advisory_area");
    assert.equal(f.source_url, o.canonical_url);
    assertBounded(f, [feature.geometry]);
    // The point and radius stay the legacy display convention and the spatial index key.
    const area = polygonArea(feature.geometry)!;
    assert.deepEqual(
      [o.source_geo!.lon, o.source_geo!.lat, o.source_geo!.radius_km],
      [area.lon, area.lat, area.radius_km],
    );
  }
  const ecccLargest = Math.max(
    ...eccc.features.map((f: any) => f.geometry.coordinates[0].length),
  );
  assert.equal(ecccLargest, 151, "the fixture's largest region");
});

test("a dense outline is simplified under its ceiling by doubling the tolerance, and an unboundable one is not stored", () => {
  const ring: Position[] = Array.from({ length: 5000 }, (_, i) => {
    const a = (2 * Math.PI * i) / 5000,
      r = 3 + 0.05 * Math.sin(40 * a);
    return [-120 + r * Math.cos(a) * 2, 60 + r * Math.sin(a)];
  });
  ring.push(ring[0]);
  const geometry = { type: "Polygon", coordinates: [ring] };
  const f = buildFootprint("advisory_area", "https://example.invalid/a", [
    { geometry },
  ])!;
  assertBounded(f, [geometry]);
  assert.ok(
    f.detail!.tolerance_km > FOOTPRINT_LIMITS.detail.tolerance_km,
    "the starting tolerance was raised",
  );
  // A thousand separate specks need four positions each, past any tolerance.
  const specks = {
    type: "MultiPolygon",
    coordinates: Array.from({ length: 1000 }, (_, i) => [
      [
        [i * 0.1, 0],
        [i * 0.1 + 0.01, 0],
        [i * 0.1, 0.01],
        [i * 0.1, 0],
      ],
    ]),
  };
  assert.equal(
    buildFootprint("advisory_area", "https://example.invalid/b", [
      { geometry: specks },
    ]),
    null,
  );
  assert.equal(
    buildFootprint("advisory_area", "https://example.invalid/c", [
      { geometry: { type: "Point", coordinates: [0, 0] } },
    ]),
    null,
  );
});

test("an issuer polygon across 180° stays continuous and meets watch areas on either side of the meridian", () => {
  const aleutian = {
    type: "Polygon",
    coordinates: [
      [
        [179.5, 51.5],
        [-179.2, 51.5],
        [-179.2, 52.4],
        [179.5, 52.4],
        [179.5, 51.5],
      ],
    ],
  };
  const f = buildFootprint(
    "advisory_area",
    "https://api.weather.gov/alerts/x",
    [{ geometry: aleutian }],
  )!;
  assert.ok(validFootprint(f));
  const ring = (f.detail!.parts[0].geometry as any)
    .coordinates[0] as Position[];
  assert.ok(
    ring.every((p, i) => i === 0 || Math.abs(p[0] - ring[i - 1][0]) <= 180),
    "no edge jumps across the map",
  );
  assert.deepEqual(
    ring
      .map((p) => p[0])
      .sort((a, b) => a - b)
      .at(-1),
    180.8,
  );
  const meets = (geometry: unknown) =>
    footprintMeetsArea(f.detail!, areaRing(geometry)!);
  assert.equal(
    meets({ bbox: [179, 51, -179, 53] }),
    true,
    "a watch box across the meridian",
  );
  assert.equal(
    meets({ bbox: [-179.5, 51.8, -179.3, 52] }),
    true,
    "west longitudes inside the warning",
  );
  assert.equal(
    meets({ bbox: [179.7, 51.6, 179.9, 51.8] }),
    true,
    "east longitudes inside the warning",
  );
  assert.equal(
    meets({ bbox: [-178.5, 51.6, -178.3, 51.8] }),
    false,
    "east of the warning",
  );
  assert.equal(meets({ bbox: [170, 51, 175, 52] }), false);
  assert.equal(
    meets({
      type: "Polygon",
      coordinates: [
        [
          [179.9, 51],
          [-179.9, 51],
          [-179.9, 53],
          [179.9, 53],
          [179.9, 51],
        ],
      ],
    }),
    true,
    "a watch polygon across the meridian",
  );
  // The same warning written with eastern longitudes past 180 lands in the same place.
  const east = buildFootprint(
    "advisory_area",
    "https://api.weather.gov/alerts/x",
    [
      {
        geometry: {
          ...aleutian,
          coordinates: [
            aleutian.coordinates[0].map(([x, y]) => [x < 0 ? x + 360 : x, y]),
          ],
        },
      },
    ],
  )!;
  assert.deepEqual(east.detail, f.detail);
  // An edge that jumps a hemisphere is refused at ingest.
  const broken = structuredClone(f);
  (broken.detail!.parts[0].geometry as any).coordinates[0][1][0] = -179.2;
  assert.equal(validFootprint(broken), false);
});

const now = Date.parse("2026-10-23T12:00:00Z");
function warning(o: ObservationInput): IncidentView {
  const g = o.source_geo!;
  return {
    id: "fixture-" + o.native_id,
    version: 1,
    headline: o.title,
    summary_en: "",
    summary_it: null,
    activity: "severe_weather",
    impact: "severe",
    evidence_status: "official_advisory",
    location: {
      name: g.name,
      country: g.country ?? null,
      lon: g.lon,
      lat: g.lat,
      accuracy: g.accuracy,
      radius_km: g.radius_km!,
    },
    ...(o.footprint ? { footprint: o.footprint } : {}),
    event_start: new Date(now - 600000).toISOString(),
    event_end: null,
    published_at: null,
    ingested_at: new Date(now).toISOString(),
    analyzed_at: null,
    updated_at: new Date(now).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
    claims: [],
    reports: [],
    history: [],
    review_needed: false,
    cancelled: false,
  };
}

test("a watch area inside a warning's circle but outside its polygon gets no alert; one inside the polygon does", () => {
  // The thinnest warning in the fixture, whose circle covers far more than its polygon.
  const all = parseNws(nwsSource, nws).map(warning);
  const strip = all.sort(
    (a, b) =>
      shapePositions(a.footprint!.detail!) -
        shapePositions(b.footprint!.detail!) ||
      b.location!.radius_km - a.location!.radius_km,
  )[0];
  const ring = (strip.footprint!.detail!.parts[0].geometry as any)
    .coordinates[0] as Position[];
  const box = (lon: number, lat: number) => ({
    bbox: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01],
  });
  const { lon, lat, radius_km } = strip.location!;
  // Points within the circle, the farthest from the polygon outside it and one inside it.
  const candidates: Position[] = [];
  for (let dx = -1; dx <= 1; dx += 0.05)
    for (let dy = -1; dy <= 1; dy += 0.05)
      if (Math.hypot(dx, dy) < 0.8)
        candidates.push([
          lon + (dx * radius_km) / (111.32 * Math.cos((lat * Math.PI) / 180)),
          lat + (dy * radius_km) / 111.32,
        ]);
  const outside = candidates
    .filter(
      (p) =>
        footprintMeetsArea(strip.footprint!.detail!, areaRing(box(...p))!) ===
        false,
    )
    .sort((a, b) => distance(b, ring) - distance(a, ring))[0];
  assert.ok(outside, "the circle reaches beyond the polygon");
  assert.ok(distance(outside, ring) > 2);
  const rule = { watch_area_id: "watch" };
  assert.equal(
    intersects(strip.location, box(...outside)),
    true,
    "the radius alone would alert",
  );
  assert.equal(reaches(strip, box(...outside)), false);
  assert.deepEqual(
    alertDecision(strip, rule, box(...outside), null, new Date(now)),
    {
      state: "suppressed",
      reason: "outside_watch_area_or_unresolved",
    },
  );
  const inside = ring
    .slice(0, 3)
    .reduce((s, p) => [s[0] + p[0] / 3, s[1] + p[1] / 3], [0, 0]) as Position;
  const alerted = alertDecision(
    strip,
    rule,
    box(...inside),
    null,
    new Date(now),
  );
  assert.equal(alerted.state, "eligible_ui");
  assert.match(
    alerted.reason,
    /^issuer_area_notice; advisory_area overlaps watch area$/,
  );
  // The browser cue reads the list view's display copy and agrees.
  const listed = listView(strip) as unknown as IncidentView;
  assert.equal(listed.footprint!.detail, undefined);
  const area = (p: Position) => ({
    id: "a",
    name: "a",
    minimum: "severe",
    bbox: box(...p).bbox.join(","),
  });
  assert.equal(intersectsArea(listed, area(outside)), false);
  assert.equal(intersectsArea(listed, area(inside)), true);
  // Without geometry the point and radius decide, as before.
  const { footprint, ...bare } = strip;
  assert.equal(
    alertDecision(bare, rule, box(...outside), null, new Date(now)).state,
    "eligible_ui",
  );
  assert.equal(intersectsArea(bare, area(outside)), true);
});

test("a watch area inside a polygon's hole is outside it, and contour lines fall back to the radius", () => {
  const holed = buildFootprint("advisory_area", "https://example.invalid/h", [
    {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [3, 3],
            [7, 3],
            [7, 7],
            [3, 7],
            [3, 3],
          ],
        ],
      },
    },
  ])!;
  assert.equal(
    footprintMeetsArea(
      holed.detail!,
      areaRing({ bbox: [4.5, 4.5, 5.5, 5.5] })!,
    ),
    false,
  );
  assert.equal(
    footprintMeetsArea(holed.detail!, areaRing({ bbox: [2, 2, 3.5, 3.5] })!),
    true,
  );
  assert.equal(
    footprintMeetsArea(holed.detail!, areaRing({ bbox: [1, 1, 2, 2] })!),
    true,
  );
  const quake = {
    ...warning(parseNws(nwsSource, nws)[0]),
    footprint: parseShakeMapContours(contours, CONTOURS_URL)!,
  };
  assert.equal(
    footprintMeetsArea(
      quake.footprint.detail!,
      areaRing({ bbox: [0, 0, 1, 1] })!,
    ),
    null,
  );
  const far = {
    bbox: [
      quake.location!.lon + 20,
      quake.location!.lat,
      quake.location!.lon + 21,
      quake.location!.lat + 1,
    ],
  };
  assert.equal(reaches(quake, far), intersects(quake.location, far));
});

test("ShakeMap contours stay MMI contour lines read from the preferred product named by the event detail", () => {
  assert.equal(shakeMapContoursURL(detail), CONTOURS_URL);
  assert.equal(shakeMapContoursURL({ properties: { products: {} } }), null);
  const f = parseShakeMapContours(contours, CONTOURS_URL)!;
  assert.equal(f.role, "shaking_intensity");
  assert.equal(f.source_url, CONTOURS_URL);
  assert.ok(
    f.detail!.parts.every((p) => p.geometry.type === "MultiLineString"),
    "no area is inferred",
  );
  assert.deepEqual(
    f.detail!.parts.map((p) => p.level),
    contours.features.map((c: any) => c.properties.value),
  );
  assertBounded(
    f,
    contours.features.map((c: any) => c.geometry),
  );
  assert.throws(
    () => parseShakeMapContours({}, CONTOURS_URL),
    /invalid_shakemap_contours/,
  );
  // Only quakes with a PAGER alert or at M6+ are worth a detail read.
  const usgs = fixture("usgs-summary.json");
  const rows = parseUsgs(usgsSource, usgs);
  assert.ok(rows.every((o) => shakeMapDetailURL(o) === null));
  const orange = structuredClone(usgs);
  orange.features[0].properties.alert = "orange";
  assert.equal(
    shakeMapDetailURL(parseUsgs(usgsSource, orange)[0]),
    `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${orange.features[0].id}.geojson`,
  );
});

test("GDACS cyclone geometry keeps the three cumulative wind buffers as a modelled area", () => {
  const events = parseGdacs(gdacsSource, fixture("gdacs-events.json"));
  const urls = events.map(gdacsGeometryURL).filter(Boolean);
  assert.ok(urls.length > 0 && urls.length < events.length, "cyclones only");
  assert.match(
    urls[0]!,
    /^https:\/\/www\.gdacs\.org\/gdacsapi\/api\/polygons\/getgeometry\?eventtype=TC&eventid=\d+&episodeid=\d+$/,
  );
  const f = parseGdacsGeometry(cyclone, GEOMETRY_URL)!;
  assert.equal(f.role, "inferred_affected_area");
  assert.deepEqual(
    f.detail!.parts.map((p) => [p.level, p.label]),
    [
      [60, "60 km/h"],
      [90, "90 km/h"],
      [120, "120 km/h"],
    ],
  );
  const buffers = cyclone.features.filter((c: any) =>
    / km\/h$/.test(c.properties.polygonlabel),
  );
  assert.equal(
    buffers.length,
    3,
    "the forecast-time buffer and track line are left out",
  );
  assertBounded(
    f,
    buffers.map((c: any) => c.geometry),
  );
  assert.throws(
    () => parseGdacsGeometry([], GEOMETRY_URL),
    /invalid_gdacs_geometry/,
  );
});

test("the collector reads a changed quake's ShakeMap once and reads it again after a failed attempt", async () => {
  const summary = fixture("usgs-summary.json");
  const quake = summary.features[0];
  quake.id = "us6000u43g";
  quake.properties.alert = "orange";
  const detailURL =
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us6000u43g.geojson";
  let state: FetchState = {},
    // The fetch layer stamps its checkpoint with the wall clock.
    clock = Date.now(),
    contoursStatus = 500;
  const run = async () => {
    const requested: string[] = [],
      accepted: ObservationInput[] = [];
    await collectSources(
      {
        EW_API_URL: "https://isolated.invalid",
        EW_COLLECTOR_TOKEN: "isolated-fixture",
      },
      {
        sources: [usgsSource],
        register: async () => {},
        checkpoint: async () => state,
        recordHealth: async (_, h) => {
          state = h.checkpoint;
        },
        ingest: async (rows) => {
          accepted.push(...rows);
        },
        fetch: async (url) => {
          requested.push(String(url));
          if (String(url) === USGS_FEED_URL) return Response.json(summary);
          if (String(url) === detailURL) return Response.json(detail);
          if (String(url) === CONTOURS_URL)
            return contoursStatus === 200
              ? Response.json(contours)
              : new Response("busy", { status: contoursStatus });
          throw Error("unexpected " + url);
        },
        now: () => clock,
      },
    );
    clock += 3600000;
    return {
      requested,
      footprint: accepted.find((o) => o.native_id === "us6000u43g")?.footprint,
    };
  };
  const failed = await run();
  assert.deepEqual(failed.requested, [USGS_FEED_URL, detailURL, CONTOURS_URL]);
  assert.equal(
    failed.footprint,
    undefined,
    "the quake publishes without geometry",
  );
  assert.deepEqual(state.footprints, {
    read: 1,
    pending: ["us6000u43g"],
    error: "source_http_500",
  });
  contoursStatus = 200;
  const retried = await run();
  assert.deepEqual(retried.requested, [USGS_FEED_URL, detailURL, CONTOURS_URL]);
  assert.equal(retried.footprint?.role, "shaking_intensity");
  assert.deepEqual(state.footprints, { read: 1, pending: [], error: null });
  assert.deepEqual(
    state.issuer_lag,
    [],
    "a geometry retry is not a second issuer-lag sample",
  );
  const unchanged = await run();
  assert.deepEqual(
    unchanged.requested,
    [USGS_FEED_URL],
    "an unchanged quake is not read again",
  );
});

test("the issuer path stores the footprint beside the location and keeps it out of search and list views", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const e = env(sqliteD1(db));
  const api = async (path: string, body?: unknown, token = OWNER) => {
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
  assert.equal(
    (await api("/api/sources", { sources: [nwsSource] }, COLLECTOR)).status,
    200,
  );
  const rows = parseNws(nwsSource, nws).slice(0, 3);
  assert.equal(
    (await api("/api/ingest", { observations: rows }, COLLECTOR)).status,
    200,
  );
  const full: IncidentView[] = (await api("/api/snapshot?include_incoming=0"))
    .body.incidents;
  assert.equal(full.length, 3);
  for (const i of full) {
    const o = rows.find((r) => r.title === i.headline)!;
    assert.deepEqual(i.footprint, o.footprint);
    assert.equal(i.location!.radius_km, o.source_geo!.radius_km);
  }
  const listed: IncidentView[] = (
    await api("/api/snapshot?include_incoming=0&view=list")
  ).body.incidents;
  for (const i of listed)
    assert.deepEqual(Object.keys(i.footprint!), ["role", "display"]);
  const search = db.prepare("SELECT search_text FROM incidents_fts").all() as {
    search_text: string;
  }[];
  assert.equal(search.length, 3);
  assert.ok(
    search.every((r) => !r.search_text.includes('"footprint"')),
    "coordinates are not search terms",
  );
  // A ring that is not closed is refused.
  const bad = structuredClone(parseNws(nwsSource, nws)[3]);
  (bad.footprint!.detail!.parts[0].geometry as any).coordinates[0].pop();
  const refused = await api("/api/ingest", { observations: [bad] }, COLLECTOR);
  assert.equal(refused.body.error, "invalid_footprint");
});

test("list views carry only display footprints within their byte budget", async () => {
  const all = await views(400, 11, 400);
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const listed = all.map(listView);
  const drawn = listed.filter((v) => v.footprint);
  assert.ok(
    drawn.length > 100,
    "the synthetic world includes NWS and ECCC warnings",
  );
  for (const v of drawn) {
    assert.equal((v.footprint as any).detail, undefined);
    assert.ok(
      shapePositions(v.footprint!.display) <=
        FOOTPRINT_LIMITS.display.positions,
    );
  }
  const added = bytes(listed) - bytes(listed.map(({ footprint, ...v }) => v));
  // Measured 23 October 2026: 232 bytes per warning footprint, 6.2% of this list.
  assert.ok(
    added / drawn.length < 400,
    `${Math.round(added / drawn.length)} bytes per footprint`,
  );
  assert.ok(added < 0.1 * bytes(listed), `${added} of ${bytes(listed)} bytes`);
});

test("a GeoJSON feed carries display footprints within its budget and counts the ones it leaves out", () => {
  // A hundred entries whose display copies sit at the 240-position ceiling, the worst case.
  const ring: Position[] = Array.from({ length: 239 }, (_, k) => [
    -100.12 + 3 * Math.cos((2 * Math.PI * k) / 239),
    45.12 + 3 * Math.sin((2 * Math.PI * k) / 239),
  ]);
  ring.push(ring[0]);
  const base = warning(parseNws(nwsSource, nws)[0]);
  const entries = Array.from({ length: 100 }, (_, n) => ({
    id: "e" + n,
    incident: {
      ...base,
      id: "e" + n,
      headline: "x".repeat(300),
      reports: [
        {
          canonical_url: "https://api.weather.gov/alerts/" + n,
          rights: { ...nwsSource.rights },
        },
      ],
      footprint: {
        role: "advisory_area" as const,
        display: {
          tolerance_km: 2.79,
          parts: [
            { geometry: { type: "Polygon" as const, coordinates: [ring] } },
          ],
        },
      },
    },
    updated: new Date(now - n * 60000).toISOString(),
    correction: null,
  }));
  const feed = geojsonFeed(
    {
      id: "f",
      title: "t",
      subtitle: "s",
      self: "a",
      alternate: "b",
      attribution: [nwsSource.rights.attribution],
      updated: "u",
    },
    entries,
  );
  const carried = feed.features.filter((f) => f.properties.footprints);
  assert.ok(carried.length > 0 && carried.length < 100);
  assert.equal(feed.footprints_omitted, 100 - carried.length);
  assert.deepEqual(
    carried,
    feed.features.slice(0, carried.length),
    "the newest entries keep theirs",
  );
  assert.ok(
    JSON.stringify(carried.map((f) => f.properties.footprints)).length <=
      FEED_FOOTPRINT_BYTES + 100,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(feed)) <= FEED_FILE_LIMIT,
    `${Buffer.byteLength(JSON.stringify(feed))} bytes`,
  );
});
