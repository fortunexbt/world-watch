import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPlatformProxy } from "wrangler";
import server, { type Env } from "../src/server/index";

const DAY = 86400000,
  iso = (ms: number) => new Date(ms).toISOString();

/**
 * D1 bills every row a query steps through, index entries included, and only the local D1 engine
 * reports that count, so this store is seeded on disk and then read through Miniflare.
 */
test("replay reads stay within budget on a store with a busy and a quiet region", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "world-watch-replay-")),
    config = path.join(dir, "wrangler.json"),
    persist = { path: path.join(dir, "state") };
  writeFileSync(
    config,
    JSON.stringify({
      name: "replay-budget",
      compatibility_date: "2026-10-21",
      d1_databases: [{ binding: "DB", database_name: "replay", database_id: "00000000-0000-0000-0000-000000000000" }],
    }),
  );
  const open = () => getPlatformProxy({ configPath: config, persist, remoteBindings: false, envFiles: [] });
  let proxy: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // The first proxy only creates the database file, which is then migrated and seeded directly.
    proxy = await open();
    await (proxy.env as any).DB.prepare("SELECT 1").all();
    await proxy.dispose();
    proxy = undefined;
    const files = path.join(persist.path, "d1/miniflare-D1DatabaseObject");
    const db = new DatabaseSync(path.join(files, readdirSync(files).find((f) => f.endsWith(".sqlite"))!));
    for (const file of readdirSync("deploy/migrations").sort())
      db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
    db.prepare("INSERT INTO sources(id,record) VALUES('open',?)").run(
      JSON.stringify({ id: "open", rights: { access: true, storage: true, ai: false, display: true } }),
    );
    const end = Date.parse("2026-10-20T00:00:00Z"),
      start = end - 30 * DAY;
    let seed = 5;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const incident = db.prepare("INSERT INTO incidents(id,version,view,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,view=excluded.view,updated_at=excluded.updated_at"),
      revision = db.prepare("INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,'fixture')");
    db.exec("BEGIN");
    // 6,000 short warnings over the contiguous US, 150 quakes in the Sahara, each revised up to twice.
    for (let n = 0; n < 6150; n++) {
      const busy = n < 6000;
      let known = start + random() * (end - start);
      for (let version = 1; version <= 1 + Math.floor(random() * 3); version++) {
        const view = {
          id: `i${n}`,
          version,
          headline: busy ? "Severe thunderstorm warning" : "Earthquake in the Sahara",
          activity: busy ? "storm" : "earthquake",
          impact: "minor",
          evidence_status: "official_advisory",
          location: busy
            ? { name: "us", lon: -120 + random() * 50, lat: 28 + random() * 18, accuracy: "area", radius_km: 30 }
            : { name: "sahara", lon: random() * 25, lat: 18 + random() * 10, accuracy: "point", radius_km: 0 },
          event_start: iso(known - random() * 3600000),
          expires_at: busy ? iso(known + 6 * 3600000) : null,
          published_at: null,
          claims: [],
          reports: [{ source_id: "open", report_id: `r${n}`, canonical_url: `https://example.com/${n}` }],
        };
        incident.run(view.id, version, JSON.stringify(view), iso(known));
        revision.run(view.id, version, JSON.stringify(view), iso(known));
        known += 600000 + random() * 6 * 3600000;
      }
    }
    db.exec("COMMIT");
    const total = Number((db.prepare("SELECT count(*) AS n FROM incident_revisions").get() as any).n);
    db.close();

    proxy = await open();
    // Counted around the binding, as scripts/load-harness.ts does: the proxy's statements are remote objects.
    const d1 = (proxy.env as any).DB;
    let rowsRead = 0;
    const note = (result: any) => ((rowsRead += result.meta.rows_read), result);
    const wrap = (s: any): any => ({
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      all: async () => note(await s.all()),
      run: async () => note(await s.run()),
      first: async () => (await s.all().then(note)).results[0] ?? null,
    });
    const env = {
      DB: { prepare: (sql: string) => wrap(d1.prepare(sql)) },
      ASSETS: { fetch: async () => new Response("fixture") },
      EUROPE_WATCH_OWNER_TOKEN: "owner",
    } as unknown as Env;
    const read = async (query: string) => {
      const before = rowsRead;
      const response = await server.fetch(
        new Request("https://fixture.invalid/api/snapshot?include_incoming=0&view=list&" + query, {
          headers: { authorization: "Bearer owner" },
        }),
        env,
      );
      assert.equal(response.status, 200);
      return { rows: rowsRead - before, incidents: ((await response.json()) as any).incidents.length as number };
    };
    // Warm the per-isolate caches (status, reach, history start) the way a live isolate holds them.
    await read(`hours=24&at=${iso(end - DAY)}`);
    const sahara = "bbox=-5,15,30,30",
      conus = "bbox=-125,24,-66,50";
    // Before revisions_cell, every one of these read 7,552 to 7,921 rows: the newest 1,000 held
    // revisions, filtered afterwards, so the quiet area lost a quarter to nearly half of its incidents.
    for (const back of [3600000, DAY, 7 * DAY, 21 * DAY]) {
      const at = iso(end - back);
      // A quiet area reads its own cells' window, not the busy region's history.
      const quiet = await read(`hours=168&${sahara}&at=${at}`);
      assert.ok(quiet.incidents > 0, `quiet ${at}`);
      assert.ok(quiet.rows <= 400, `quiet area replay at ${at} read ${quiet.rows} of ${total}`);
      // However far back, a busy area passes over only a few days of later revisions.
      const busy = await read(`hours=24&${conus}&at=${at}`);
      assert.ok(busy.incidents > 0, `busy ${at}`);
      assert.ok(busy.rows <= 3500, `busy area replay at ${at} read ${busy.rows} of ${total}`);
      // The world stops at the 1,000-incident limit, whatever the store holds before `at`.
      const world = await read(`hours=168&at=${at}`);
      assert.equal(world.incidents, 1000);
      assert.ok(world.rows <= 2500, `world replay at ${at} read ${world.rows} of ${total}`);
    }
  } finally {
    await proxy?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
