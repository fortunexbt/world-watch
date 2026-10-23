import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import server, { type Env } from "../src/server/index";
import { situations } from "../src/shared/fusion";
import { incidentInWindow } from "../src/shared/temporal";
import { inBbox, textMatch } from "../src/shared/view";
import type { IncidentView } from "../src/shared/contracts";

const DAY = 86400000,
  iso = (ms: number) => new Date(ms).toISOString();
const rights = (display: boolean) => ({
  rights: { access: true, storage: true, ai: false, display, redistribute: true },
});

/** A migrated in-memory store whose incidents and revisions are written directly, with the owner API over it. */
function store() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations").sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  for (const [id, display] of [["open", true], ["withdrawn", true]] as const)
    db.prepare("INSERT INTO sources(id,record) VALUES(?,?)").run(id, JSON.stringify({ id, ...rights(display) }));
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
        return { meta: db.prepare(sql).run(...values) };
      },
    };
  };
  const env = {
    DB: {
      prepare,
      async batch(list: { run(): Promise<unknown> }[]) {
        db.exec("BEGIN");
        try {
          const out = [];
          for (const s of list) out.push(await s.run());
          db.exec("COMMIT");
          return out;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    ASSETS: { fetch: async () => new Response("fixture") },
    EUROPE_WATCH_OWNER_TOKEN: "owner",
  } as unknown as Env;
  const api = async (path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request("https://fixture.invalid" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
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
    /** Writes `view` as revision `view.version`, known at `known`, and as the live incident when it is the newest. */
    revise(view: IncidentView, known: number) {
      db.prepare(
        "INSERT INTO incidents(id,version,view,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,view=excluded.view,updated_at=excluded.updated_at WHERE excluded.version>incidents.version",
      ).run(view.id, view.version, JSON.stringify(view), iso(known));
      db.prepare("INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)").run(
        view.id,
        view.version,
        JSON.stringify(view),
        iso(known),
        "fixture",
      );
    },
    async snapshot(query: string): Promise<IncidentView[]> {
      const r = await api("/api/snapshot?include_incoming=0&" + query);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.incidents;
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
const place = (lon: number, lat: number, radius_km = 8) =>
  ({ name: "fixture", country: null, lon, lat, accuracy: "city", radius_km }) as IncidentView["location"];
function view(id: string, version: number, fields: Partial<IncidentView> = {}): IncidentView {
  return {
    id,
    version,
    headline: `Fixture ${id}`,
    summary_en: "Fixture.",
    summary_it: null,
    activity: "earthquake",
    impact: "minor",
    evidence_status: "official_advisory",
    location: place(2.35, 48.85),
    event_start: null,
    event_end: null,
    published_at: null,
    ingested_at: null,
    analyzed_at: null,
    updated_at: null,
    expires_at: null,
    claims: [],
    reports: [{ source_id: "open", report_id: `${id}-r`, canonical_url: `https://example.com/${id}` }],
    review_needed: false,
    cancelled: false,
    ...fields,
  } as unknown as IncidentView;
}
/** Deterministic PRNG (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("replay returns exactly each incident's latest revision known by then, judged on that view, and never a later one", async () => {
  const s = store(),
    r = random(11),
    pick = <T>(list: T[]) => list[Math.floor(r() * list.length)];
  const end = Date.parse("2026-10-20T00:00:00Z"),
    start = end - 30 * DAY;
  const places = [
    place(2.35, 48.85),
    place(178.4, -18.1, 20),
    place(-179.6, -17.9, 300),
    place(139.7, 35.7),
    place(-95, 38, 50),
    null,
  ];
  const headlines = ["Flood near Zürich", "Storm BETA reaches coast", "Quake felt in Suva", "Warning lifted"];
  const revisions: { view: IncidentView; known: number }[] = [];
  for (let n = 0; n < 400; n++) {
    let known = start + r() * (end - start);
    const count = 1 + Math.floor(r() * 4);
    for (let version = 1; version <= count; version++) {
      const event = known - r() * 3 * DAY;
      const v = view(`i${n}`, version, {
        headline: pick(headlines),
        location: pick(places),
        event_start: r() < 0.85 ? iso(event) : null,
        published_at: r() < 0.5 ? iso(known) : null,
        expires_at: r() < 0.3 ? iso(event + r() * 10 * DAY) : null,
        ...(r() < 0.1 ? { current_listing: true } : {}),
        ...(r() < 0.05 ? { superseded_by: `i${(n + 1) % 400}` } : {}),
        cancelled: r() < 0.1,
        // A later revision can bring in a source whose display right is withdrawn below.
        reports: [
          { source_id: "open", report_id: `i${n}-r`, canonical_url: `https://example.com/${n}` },
          ...(version > 1 && r() < 0.2
            ? [{ source_id: "withdrawn", report_id: `i${n}-w`, canonical_url: `https://example.com/w${n}` }]
            : []),
        ],
      } as Partial<IncidentView>);
      revisions.push({ view: v, known });
      known += 600000 + r() * 2 * DAY;
    }
  }
  // Shuffled, so a lower version can arrive after a higher one and must still be superseded by it.
  const order = revisions.map((x) => ({ x, k: r() })).sort((a, b) => a.k - b.k);
  for (const { x } of order) s.revise(x.view, x.known);
  s.db.prepare("UPDATE sources SET record=? WHERE id='withdrawn'").run(JSON.stringify({ id: "withdrawn", ...rights(false) }));

  const boxes = [undefined, [-10, 35, 30, 60], [170, -25, -170, -10], [120, 20, 150, 50], [-130, 20, -60, 55]];
  for (let k = 0; k < 80; k++) {
    const at = start - DAY + r() * (end - start + 2 * DAY),
      hours = pick([0, 24, 168]),
      bbox = pick(boxes),
      q = pick(["", "", "zürich", "beta", "Suva"]);
    const params = new URLSearchParams({ at: iso(at), hours: String(hours) });
    if (bbox) params.set("bbox", bbox.join(","));
    if (q) params.set("q", q);
    const found = await s.snapshot(params.toString());
    // Whatever the query, nothing known after `at` reaches the result.
    for (const i of found) {
      const held = revisions.filter((x) => x.view.id === i.id && x.known <= at);
      assert.ok(held.length, `${i.id} was not known at ${iso(at)}`);
      assert.equal(i.version, Math.max(...held.map((x) => x.view.version)), `${i.id} at ${iso(at)}`);
    }
    const expected = new Map<string, IncidentView>();
    for (const x of revisions)
      if (x.known <= at && (expected.get(x.view.id)?.version ?? 0) < x.view.version) expected.set(x.view.id, x.view);
    const visible = [...expected.values()]
      .filter(
        (v) =>
          !v.superseded_by &&
          v.reports.every((p: any) => p.source_id === "open") &&
          incidentInWindow(v, hours, at) &&
          (!bbox || inBbox(v.location, bbox)) &&
          (!q || textMatch(v, q)),
      )
      .map((v) => `${v.id}@${v.version}`)
      .sort();
    assert.deepEqual(found.map((i) => `${i.id}@${i.version}`).sort(), visible, params.toString());
  }

  // A replayed detail is the revision held then, with only the history known by then.
  const target = revisions.find((x) => x.view.id === "i7" && x.view.version === 2) ?? revisions[1];
  const detail = await s.api(`/api/incidents/${target.view.id}?at=${iso(target.known + 1000)}`);
  assert.equal(detail.body.version, target.view.version);
  assert.ok(detail.body.history.every((h: any) => Date.parse(h.known_at) <= target.known + 1000));
  assert.equal((await s.api(`/api/incidents/${target.view.id}?at=${iso(start - 2 * DAY)}`)).status, 404);
});

test("a corrected location moves an incident between areas only from the time the correction was known", async () => {
  const s = store(),
    now = Date.now(),
    paris = place(2.35, 48.85),
    tokyo = place(139.7, 35.7);
  s.revise(view("moved", 1, { location: paris, event_start: iso(now - 3 * DAY) }), now - 3 * DAY);
  s.revise(view("moved", 2, { location: tokyo, event_start: iso(now - 3 * DAY), evidence_status: "corrected" }), now - 2 * DAY);
  const europe = "bbox=-10,35,30,60&hours=168",
    japan = "bbox=120,20,150,50&hours=168";
  const before = iso(now - 2.5 * DAY),
    after = iso(now - DAY);
  assert.deepEqual((await s.snapshot(`${europe}&at=${before}`)).map((i) => i.version), [1]);
  // Window keys are bounded on both sides in the cell index; lasting revisions come from their own.
  assert.match(
    s.plan("SELECT view,known_at FROM incident_revisions"),
    /USING INDEX revisions_cell \(<expr>=\? AND <expr>>\? AND <expr><\?\).*USING INDEX revisions_lasting \(<expr>=\? AND <expr>>\?\)/,
  );
  assert.match(s.plan("SELECT max("), /USING (COVERING )?INDEX revisions_radius/);
  assert.deepEqual(await s.snapshot(`${japan}&at=${before}`), []);
  // The first revision still matches Europe but is no longer what the platform held.
  assert.deepEqual(await s.snapshot(`${europe}&at=${after}`), []);
  assert.deepEqual((await s.snapshot(`${japan}&at=${after}`)).map((i) => i.version), [2]);
  assert.deepEqual((await s.snapshot("hours=168")).map((i) => i.version), [2]);
  // Without an area the knowledge-time index serves the read and stops at its limit.
  await s.snapshot(`hours=168&at=${before}`);
  assert.match(s.plan("SELECT view FROM incident_revisions"), /USING INDEX incident_replay/);
});

test("replay shows the fusion links known then, and an operator split only from when it was made", async () => {
  const s = store(),
    now = Date.now(),
    start = iso(now - 2 * DAY);
  const usgs = view("usgs", 1, { event_start: start }),
    emsc = view("emsc", 1, { event_start: start, location: place(2.4, 48.9) });
  s.revise(usgs, now - 2 * DAY);
  s.revise(emsc, now - 2 * DAY + 60000);
  // The link endpoint records evidence links, which need their observations.
  for (const id of ["usgs", "emsc"])
    s.db
      .prepare("INSERT INTO observations(id,source_id,native_id,canonical_url,first_observed_at,latest_revision) VALUES(?,'open',?,?,?,'r1')")
      .run(`${id}-r`, id, `https://example.com/${id}`, start);
  const same = { type: "same_event", basis: "fixture-rule", independence: "independent", reason: "same origin time and place" } as const;
  s.revise({ ...usgs, version: 2, links: [{ ...same, incident_id: "emsc" }] } as IncidentView, now - DAY);
  s.revise({ ...emsc, version: 2, links: [{ ...same, incident_id: "usgs" }] } as IncidentView, now - DAY);
  const split = await s.api("/api/incidents/link", { ids: ["usgs", "emsc"], linked: false, reason: "different events" });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const groups = async (query: string) => situations(await s.snapshot(query)).map((g) => (g.members ?? [g]).length);
  assert.deepEqual(await groups(`hours=168&at=${iso(now - 1.5 * DAY)}`), [1, 1]);
  assert.deepEqual(await groups(`hours=168&at=${iso(now - DAY / 2)}`), [2]);
  assert.deepEqual((await groups("hours=168")).sort(), [1, 1]);
  const detail = (await s.api(`/api/incidents/usgs?at=${iso(now - DAY / 2)}`)).body;
  assert.equal(detail.links[0].type, "same_event");
  assert.equal(detail.history.length, 2);
});

test("withdrawn rights hide replayed content, and a replayed brief is built only from what was known", async () => {
  const s = store(),
    now = Date.now();
  s.revise(view("kept", 1, { event_start: iso(now - 2 * DAY), impact: "significant", headline: "Kept quake" }), now - 2 * DAY);
  s.revise(view("later", 1, { event_start: iso(now - 2 * DAY), impact: "significant", headline: "Later quake" }), now - DAY);
  s.revise(
    view("pulled", 1, {
      event_start: iso(now - 2 * DAY),
      reports: [{ source_id: "withdrawn", report_id: "p", canonical_url: "https://example.com/p" }],
    } as Partial<IncidentView>),
    now - 2 * DAY,
  );
  const at = iso(now - 1.5 * DAY);
  assert.deepEqual((await s.snapshot(`hours=168&at=${at}`)).map((i) => i.id).sort(), ["kept", "pulled"]);
  s.db.prepare("UPDATE sources SET record=? WHERE id='withdrawn'").run(JSON.stringify({ id: "withdrawn", ...rights(false) }));
  assert.deepEqual((await s.snapshot(`hours=168&at=${at}`)).map((i) => i.id), ["kept"]);
  assert.equal((await s.api(`/api/incidents/pulled?at=${at}`)).status, 404);
  const brief = (await s.api(`/api/brief?hours=168&at=${at}`)).body.current;
  assert.equal(brief.kind, "structured");
  assert.deepEqual(brief.references.map((r: any) => r.incident_id), ["kept"]);
  assert.equal(brief.generated_at, at);
});

test("a replayed model brief is the one completed by then, checked against the revisions held then", async () => {
  const s = store(),
    now = Date.now();
  s.db
    .prepare("INSERT INTO sources(id,record) VALUES('model',?)")
    .run(JSON.stringify({ id: "model", rights: { access: true, storage: true, ai: true, display: true } }));
  // The source has revised its record since the first brief; that brief still stands for its time.
  s.db
    .prepare("INSERT INTO observations(id,source_id,native_id,canonical_url,first_observed_at,latest_revision) VALUES('m-r','model','m','https://example.com/m',?,'r2')")
    .run(iso(now - 2 * DAY));
  const reports = [{ source_id: "model", report_id: "m-r", canonical_url: "https://example.com/m" }];
  s.revise(view("m", 1, { headline: "Quake v1", event_start: iso(now - 2 * DAY), reports } as Partial<IncidentView>), now - 2 * DAY);
  s.revise(view("m", 2, { headline: "Quake v2", event_start: iso(now - 2 * DAY), reports } as Partial<IncidentView>), now - DAY / 2);
  const brief = (id: string, headline: string, end: number, completed: number, version: number, revision: string) =>
    s.db
      .prepare(
        "INSERT INTO brief_windows(id,window_start,window_end,state,input,provenance,result,run,created_at,updated_at,available_at) VALUES(?,?,?,'complete',?,?,?,'{}',?,?,?)",
      )
      .run(
        id,
        iso(end - 300000),
        iso(end),
        JSON.stringify({ incidents: [{ index: 0, headline }], counts: { reports: 1, incidents: 1, pending: 0, omitted: 0 } }),
        JSON.stringify([{ index: 0, incident_id: "m", version, reports: [{ report_id: "m-r", revision, source_id: "model" }] }]),
        JSON.stringify({ headline, references: [0], pinned: [] }),
        iso(end),
        iso(completed),
        iso(end),
      );
  brief("b1", "Earlier brief", now - 2 * DAY + 300000, now - 1.9 * DAY, 1, "r1");
  brief("b2", "Later brief", now - 0.45 * DAY, now - 0.4 * DAY, 2, "r2");
  const read = async (at?: number) =>
    (await s.api("/api/brief?hours=24" + (at ? "&at=" + iso(at) : ""))).body.current;
  assert.equal((await read()).headline, "Later brief");
  const earlier = await read(now - DAY);
  assert.equal(earlier.headline, "Earlier brief");
  assert.equal(earlier.changed_since_generated, false);
  assert.equal(earlier.generated_at, iso(now - 1.9 * DAY));
  // Its incident had a newer revision by this time, and the later brief was still being written.
  const revised = await read(now - 0.42 * DAY);
  assert.equal(revised.headline, "Earlier brief");
  assert.equal(revised.changed_since_generated, true);
  assert.notEqual((await read(now - 3 * DAY))?.kind, "model");
});

test("the migration's superseded_at backfill matches what its trigger maintains", () => {
  const files = readdirSync("deploy/migrations").sort(),
    replay = files.find((f) => f.includes("indexed_replay"))!;
  const migrated = (upTo: string[]) => {
    const db = new DatabaseSync(":memory:");
    for (const file of upTo) db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
    return db;
  };
  const before = migrated(files.filter((f) => f < replay)),
    after = migrated(files);
  const r = random(3),
    rows: [string, number, string][] = [];
  for (let n = 0; n < 200; n++)
    for (let v = 1; v <= 1 + Math.floor(r() * 4); v++) rows.push([`i${n}`, v, iso(Date.UTC(2026, 9, 1) + r() * 20 * DAY)]);
  rows.sort(() => r() - 0.5);
  for (const db of [before, after]) {
    for (const id of new Set(rows.map(([id]) => id)))
      db.prepare("INSERT OR IGNORE INTO incidents(id,version,view,updated_at) VALUES(?,1,'{}','x')").run(id);
    for (const [id, v, known] of rows)
      db.prepare("INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,'{}',?,'fixture')").run(id, v, known);
  }
  before.exec(readFileSync("deploy/migrations/" + replay, "utf8"));
  const held = (db: DatabaseSync) =>
    db.prepare("SELECT incident_id,version,superseded_at FROM incident_revisions ORDER BY incident_id,version").all();
  assert.deepEqual(held(before), held(after));
  // Each revision is superseded when the first higher version became known.
  for (const row of held(after) as any[]) {
    const later = rows.filter(([id, v]) => id === row.incident_id && v > row.version).map(([, , k]) => k).sort();
    assert.equal(row.superseded_at, later[0] ?? null);
  }
});
