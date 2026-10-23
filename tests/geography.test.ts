import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import server, { type Env } from "../src/server/index";
import { bboxCandidates, locationCell } from "../src/server/geo";
import { inBbox } from "../src/shared/view";
import { incidentInWindow } from "../src/shared/temporal";
import { intersects } from "../src/server/alerts";
import type { IncidentView } from "../src/shared/contracts";

const at = (lon: number, lat: number, radius_km = 8) =>
  ({
    name: "fixture",
    country: null,
    lon,
    lat,
    accuracy: "city",
    radius_km,
  }) as IncidentView["location"];
const suva = at(178.42531, -18.13683),
  lakeba = at(-178.8, -18.2),
  adak = at(-176.65, 51.88),
  unalaska = at(-166.54, 53.87),
  anadyr = at(177.50611, 64.73424),
  egvekinot = at(-179.11, 66.32);

test("bboxes with west > east cross the antimeridian", () => {
  const fiji = [170, -25, -170, -10];
  assert.equal(inBbox(suva, fiji), true);
  assert.equal(inBbox(lakeba, fiji), true);
  assert.equal(inBbox(at(0, -18), fiji), false);
  assert.equal(inBbox(at(-160, -18), fiji), false);
  const aleutians = [170, 45, -170, 60];
  assert.equal(inBbox(adak, aleutians), true);
  assert.equal(inBbox(unalaska, aleutians), false);
  const chukotka = [170, 60, -170, 70];
  assert.equal(inBbox(anadyr, chukotka), true);
  assert.equal(inBbox(egvekinot, chukotka), true);
  assert.equal(inBbox(at(100, 65), chukotka), false);
});
test("bbox checks wrap radii and longitudes across the dateline", () => {
  assert.equal(inBbox(at(-179.95, -17, 20), [175, -20, 180, -15]), true);
  assert.equal(inBbox(at(-179.95, -17, 0), [175, -20, 179.9, -15]), false);
  assert.equal(inBbox(at(-165, 65), [190, 60, 200, 70]), true);
  assert.equal(inBbox(at(2.35, 48.85), [-180, -90, 180, 90]), true);
  assert.equal(inBbox(at(2.35, 48.85), [2, 48, 3, 49]), true);
  assert.equal(inBbox(at(2.35, 48.85), [3.5, 48, 4, 49]), false);
});
test("watch areas crossing the antimeridian intersect by bbox or polygon ring", () => {
  assert.equal(intersects(anadyr, { bbox: [170, 60, -170, 70] }), true);
  assert.equal(intersects(at(0, 65), { bbox: [170, 60, -170, 70] }), false);
  const ring = {
    type: "Polygon",
    coordinates: [
      [
        [165, 62],
        [-170, 62],
        [-170, 72],
        [165, 72],
        [165, 62],
      ],
    ],
  };
  assert.equal(intersects(anadyr, ring), true);
  assert.equal(intersects(egvekinot, ring), true);
  assert.equal(intersects(at(0, 65), ring), false);
  const paris = {
    type: "Polygon",
    coordinates: [
      [
        [2, 48],
        [3, 48],
        [3, 49],
        [2, 49],
        [2, 48],
      ],
    ],
  };
  assert.equal(intersects(at(2.35, 48.85), paris), true);
  assert.equal(intersects(at(-170, 48.85), paris), false);
});

function store() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations").sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  db.prepare("INSERT INTO sources(id,record) VALUES('s',?)").run(
    JSON.stringify({
      rights: { access: true, storage: true, display: true, ai: true },
    }),
  );
  const reads: { sql: string; values: SQLInputValue[] }[] = [];
  const prepare = (sql: string) => {
    let values: SQLInputValue[] = [];
    return {
      bind(...next: SQLInputValue[]) {
        values = next;
        return this;
      },
      async all() {
        reads.push({ sql, values });
        return { results: db.prepare(sql).all(...values) };
      },
      async first() {
        reads.push({ sql, values });
        return db.prepare(sql).get(...values) ?? null;
      },
      async run() {
        return db.prepare(sql).run(...values);
      },
    };
  };
  const env = {
    DB: { prepare },
    ASSETS: { fetch: async () => new Response("fixture") },
    EUROPE_WATCH_OWNER_TOKEN: "owner",
  } as unknown as Env;
  let n = 0;
  return {
    db,
    reads,
    add(
      location: IncidentView["location"],
      times: Partial<IncidentView>,
      updated: string,
    ) {
      const view = {
        id: `i${++n}`,
        version: 1,
        headline: "Synthetic incident",
        summary_en: "Synthetic.",
        activity: "gathering",
        impact: "minor",
        evidence_status: "single_source",
        location,
        event_start: null,
        event_end: null,
        published_at: null,
        expires_at: null,
        updated_at: updated,
        claims: [],
        reports: [{ source_id: "s" }],
        ...times,
      };
      db.prepare(
        "INSERT INTO incidents(id,version,view,updated_at) VALUES(?,?,?,?)",
      ).run(view.id, 1, JSON.stringify(view), updated);
    },
    async snapshot(query: string) {
      const response = await server.fetch(
        new Request("https://fixture.invalid/api/snapshot?" + query, {
          headers: { authorization: "Bearer owner" },
        }),
        env,
      );
      assert.equal(response.status, 200);
      return (await response.json()) as {
        incidents: IncidentView[];
        limited: boolean;
      };
    },
    plan(prefix: string) {
      const read = reads.findLast((r) => r.sql.startsWith(prefix))!;
      return db
        .prepare("EXPLAIN QUERY PLAN " + read.sql)
        .all(...read.values)
        .map((r) => r.detail)
        .join(" | ");
    },
  };
}

test("SQL bbox candidates and their grid cells are a superset of the exact bbox check, including the dateline", () => {
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const boxes = [
    [170, -25, -170, -10],
    [170, 60, -170, 70],
    [-10, 35, 30, 60],
    [2.2, 48.8, 2.5, 48.9],
    [175, -20, 180, -15],
    [-180, -5, -175, 5],
    [-250, -10, -100, 10],
    [-180, -90, 180, 90],
    [-20, 80, 20, 90],
    [-20, -90, 20, -80],
  ];
  for (let i = 0; i < 40; i++) {
    const west = random() * 360 - 180,
      south = random() * 160 - 80;
    boxes.push([west, south, west + random() * 60 - 20, south + random() * 20]);
  }
  // Large radii widen every candidate set; small ones test the cell edges closely.
  for (const radii of [[0, 8, 20, 250, 1500], [0, 8]]) {
    const s = store();
    for (let i = 0; i < 3000; i++)
      s.add(
        at(random() * 360 - 180, random() * 170 - 85, radii[i % radii.length]),
        {},
        "2026-10-21T00:00:00Z",
      );
    // Cell edges, both poles and both sides of the antimeridian.
    for (const [lon, lat] of [[180, 0], [-180, 0], [180, -17], [-180, 66], [0, 90], [0, -90], [10, 50], [-10, -40], [179.999, 10], [-179.999, 10]])
      for (const radius of radii.slice(0, 2))
        s.add(at(lon, lat, radius), {}, "2026-10-21T00:00:00Z");
    const views = s.db
      .prepare("SELECT view FROM incidents")
      .all()
      .map((r) => JSON.parse(String(r.view)) as IncidentView);
    for (const box of boxes) {
      const c = bboxCandidates(box, Math.max(...radii));
      if (box.join() === "-180,-90,180,90") assert.equal(c.cells, null);
      const cells = c.cells ? ` AND ${locationCell} IN(${c.cells.join(",")})` : "";
      const found = new Set(
        s.db
          .prepare(
            `SELECT json_extract(view,'$.id') AS id FROM incidents WHERE deleted_at IS NULL${cells} AND ${c.sql}`,
          )
          .all(...c.params)
          .map((r) => r.id),
      );
      for (const v of views)
        if (inBbox(v.location, box)) assert.ok(found.has(v.id), `${box} ${v.id}`);
    }
  }
});

test("snapshot filters bbox and window in indexed SQL so busy regions cannot hide quiet ones", async () => {
  const s = store();
  const now = Date.now(),
    iso = (ms: number) => new Date(ms).toISOString(),
    day = 86400000;
  // 1,100 fresh European revisions of stale events push everything else past the old 1,000-row read.
  for (let i = 0; i < 1100; i++)
    s.add(
      at(2 + (i % 20) / 10, 48 + (i % 10) / 10),
      { event_start: iso(now - 90 * day) },
      iso(now - i * 1000),
    );
  for (const lon of [178.4, -179.5, 179.9])
    s.add(
      at(lon, -18),
      { event_start: iso(now - day / 2) },
      iso(now - 30 * day),
    );
  s.add(
    at(10, 50),
    { event_start: iso(now - 40 * day), expires_at: iso(now + day) },
    iso(now - 30 * day),
  );
  s.add(at(10, 50), {}, iso(now - 30 * day));

  const all = await s.snapshot("include_incoming=0");
  assert.equal(all.incidents.length, 1000);
  assert.equal(all.limited, true);
  assert.match(
    s.plan("SELECT view FROM incidents"),
    /USING INDEX incidents_recent/,
  );

  const fiji = await s.snapshot("include_incoming=0&bbox=170,-25,-170,-10");
  assert.equal(fiji.incidents.length, 3);
  assert.equal(fiji.limited, false);
  assert.match(
    s.plan("SELECT view FROM incidents"),
    /^SEARCH incidents USING INDEX incidents_cell \(<expr>=\?\)/,
  );
  assert.match(
    s.plan("SELECT max("),
    /^SEARCH incidents USING INDEX incidents_radius/,
  );

  const recent = await s.snapshot("include_incoming=0&hours=24");
  // Three recent Fiji events, one still unexpired and one without any time.
  assert.equal(recent.incidents.length, 5);
  assert.match(
    s.plan("SELECT view FROM incidents"),
    /USING INDEX incidents_recent/,
  );

  const both = await s.snapshot(
    "include_incoming=0&hours=24&bbox=-10,35,30,60",
  );
  assert.deepEqual(
    both.incidents.map((i) => i.location?.lon),
    [10, 10],
  );
  // A window seeks its keys inside each cell, so stale rows in the area are never read.
  assert.match(
    s.plan("SELECT view FROM incidents"),
    /^SEARCH incidents USING INDEX incidents_cell \(<expr>=\? AND <expr>>\?\)/,
  );
});

test("the SQL window keeps every incident incidentInWindow keeps, including issuer-current ones", async () => {
  const s = store();
  const now = Date.now(),
    hour = 3600000,
    iso = (ms: number) => new Date(ms).toISOString();
  // Offsets avoid window edges so the two clocks cannot disagree.
  const offsets = [-4000, -500, -100, -30, -5.5, -0.5, 0.5, 5.5, 30, 100, 500, 4000];
  const starts = [
    null,
    ...offsets.map((h) => iso(now + h * hour)),
    ...offsets.map((h) => iso(now + h * hour).slice(0, 10)),
  ];
  const expiries = [null, ...[-30, -0.5, 0.5, 4000].map((h) => iso(now + h * hour))];
  for (const start of starts)
    for (const expires_at of expiries)
      for (const current_listing of [undefined, true, false])
        for (const published_at of start ? [null] : [null, iso(now - 50 * hour)])
          s.add(
            at(10, 50),
            {
              event_start: start,
              published_at,
              expires_at,
              ...(current_listing === undefined ? {} : { current_listing }),
            },
            iso(now),
          );
  const views = s.db
    .prepare("SELECT view FROM incidents")
    .all()
    .map((r) => JSON.parse(String(r.view)) as IncidentView);
  assert.ok(views.length < 1000);
  for (const hours of [1, 6, 24, 72, 168]) {
    const found = (await s.snapshot(`include_incoming=0&hours=${hours}`))
      .incidents.map((i) => i.id)
      .sort();
    const kept = views
      .filter((v) => incidentInWindow(v, hours))
      .map((v) => v.id)
      .sort();
    assert.deepEqual(found, kept, `hours=${hours}`);
    assert.ok(kept.some((id) => views.find((v) => v.id === id)!.current_listing));
  }
});
