import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import server, { type Env } from "../src/server/index";
import type { ObservationInput, SourceRecord } from "../src/shared/contracts";

const source: SourceRecord = {
  id: "issuer",
  name: "Fixture issuer",
  owner: "Fixture",
  url: "https://example.com/alerts",
  docs: "https://example.com/terms",
  countries: ["FR"],
  languages: ["en"],
  categories: ["natural_hazard"],
  family: "rss",
  status: "enabled",
  poll_seconds: 300,
  rights: { access: true, storage: true, ai: false, display: true, redistribute: true, basis: "fixture only", attribution: "Fixture", retention_days: 30 },
  config: {},
  verified_at: null,
};
const warning = (n: number, text: string): ObservationInput => ({
  source_id: "issuer",
  native_id: `warning-${n}`,
  source_event_id: "event-1",
  canonical_url: `https://example.com/alerts/${n}`,
  title: "Flood warning",
  original_language: "en",
  published_at: new Date().toISOString(),
  source_updated_at: null,
  input_coverage: "full_licensed_text",
  excerpts: [{ id: "e1", text }],
  source_geo: { lon: 2.35, lat: 48.85, name: "Paris", accuracy: "area", country: "FR" },
  official: { issuer: "Fixture issuer", effective_at: new Date().toISOString(), expires_at: null, activity: "flood", impact: "minor" },
});

test("issuer revisions replace their search row by incident id, and search still finds the current text", async () => {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations").sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  const prepare = (sql: string) => {
    let values: any[] = [];
    const s = {
      bind(...v: any[]) {
        values = v.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x));
        return s;
      },
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      first: async () => db.prepare(sql).get(...values) ?? null,
      run: async () => db.prepare(sql).run(...values),
      sql,
      get values() {
        return values;
      },
    };
    return s;
  };
  const env = {
    DB: {
      prepare,
      async batch(list: any[]) {
        db.exec("BEGIN");
        const out = list.map((s) => ({ results: db.prepare(s.sql).all(...s.values) }));
        db.exec("COMMIT");
        return out;
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
    EUROPE_WATCH_OWNER_TOKEN: "owner",
    EUROPE_WATCH_COLLECTOR_TOKEN: "collector",
  } as unknown as Env;
  const call = async (path: string, token: string, body?: unknown) =>
    (
      await server.fetch(
        new Request("https://fixture.invalid" + path, {
          method: body ? "POST" : "GET",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }),
        env,
      )
    ).json() as Promise<any>;
  await call("/api/sources", "collector", { sources: [source] });
  await call("/api/ingest", "collector", { observations: [warning(1, "River levels rising near the embankment.")] });
  await call("/api/ingest", "collector", { observations: [warning(2, "Levels now falling; the warning is downgraded.")] });
  const [incident] = (await call("/api/snapshot?include_incoming=0", "owner")).incidents;
  assert.equal(incident.version, 2);
  assert.deepEqual(
    db.prepare("SELECT incident_id FROM incidents_fts").all().map((r) => r.incident_id),
    [incident.id],
  );
  assert.equal((await call("/api/snapshot?include_incoming=0&q=downgraded", "owner")).incidents.length, 1);
  assert.equal((await call("/api/snapshot?include_incoming=0&q=embankment", "owner")).incidents.length, 0);
});
