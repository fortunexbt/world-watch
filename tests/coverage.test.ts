import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { collectSources } from "../src/collector/index.js";
import type { FetchState } from "../src/collector/fetch.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { USGS_FEED_URL } from "../src/collector/adapters/usgs.js";
import server, { type Env } from "../src/server/index.js";
import { translate } from "../src/client/locale.js";
import type { IncidentView, SourceRecord } from "../src/shared/contracts.js";
import {
  COLLECTOR_CADENCE_SECONDS,
  LAG_SAMPLES,
  LAG_WINDOW_SECONDS,
  issuerLag,
  keepLag,
  layerCoverage,
  publicationLag,
  sourceCoverage,
  sourceLatency,
  summarise,
  type LagSample,
} from "../src/shared/coverage.js";
import { SNAPSHOT_CADENCE_SECONDS } from "../src/shared/public-snapshot.js";

const now = Date.parse("2026-10-23T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const source = (id: string) => sourceRegistry.find((s) => s.id === id)!;
const usgs = source("global-usgs-earthquakes");
const status = (s: SourceRecord, health: Parameters<typeof sourceCoverage>[1], cadence?: number) =>
  sourceCoverage(s, health, now, cadence).status;

test("a fresh read with listed records is observed and a fresh read listing nothing is quiet, not stale or failing", () => {
  const read = { checked_at: ago(60), last_success_at: ago(60), error: null };
  assert.equal(status(usgs, { ...read, checkpoint: { accepted_items: { a: "x", b: "y" } } }), "observed");
  assert.equal(status(usgs, { ...read, checkpoint: { accepted_items: {} } }), "quiet");
  const routing = source("global-ripestat-routing");
  assert.equal(status(routing, { ...read, checkpoint: { accepted_items: { x: "1" }, routing: { ongoing: [] } } }), "quiet");
  assert.equal(status(routing, { ...read, checkpoint: { routing: { ongoing: ["IR-2026"] } } }), "observed");
  const gdelt = source("global-gdelt-news-english");
  assert.equal(status(gdelt, { ...read, checkpoint: { accepted_items: {}, news_files: ["20261023114500"] } }), "observed");
  assert.equal(status(gdelt, { ...read, checkpoint: { accepted_items: {}, news_files: [] } }), "quiet");
  // A partial read that is resuming is not a failure; it turns stale only if the resume never completes.
  assert.equal(status(usgs, { ...read, error: "partial_fetch_accepted_resume_pending", checkpoint: { accepted_items: {} } }), "quiet");
});

test("staleness is two expected intervals from the source's own poll interval, never faster than the collector runs", () => {
  const quiet = (seconds: number) => ({ checked_at: ago(seconds), last_success_at: ago(seconds), error: null, checkpoint: { accepted_items: {} } });
  // USGS polls every five minutes: fresh at ten, stale just after.
  assert.equal(status(usgs, quiet(2 * COLLECTOR_CADENCE_SECONDS)), "quiet");
  assert.equal(status(usgs, quiet(2 * COLLECTOR_CADENCE_SECONDS + 1)), "stale");
  // Politiloggen asks for a minute, but nothing reads it more often than every five.
  assert.equal(sourceCoverage(source("no-politiloggen"), quiet(500), now).expected_seconds, COLLECTOR_CADENCE_SECONDS);
  assert.equal(status(source("no-politiloggen"), quiet(500)), "quiet");
  // FCDO is read every six hours, so eight hours without a read is still on schedule.
  assert.equal(status(source("fcdo-it"), quiet(8 * 3600)), "quiet");
  assert.equal(status(source("fcdo-it"), quiet(12 * 3600 + 1)), "stale");
  // The public snapshot runs every ten minutes.
  assert.equal(status(usgs, quiet(900), SNAPSHOT_CADENCE_SECONDS), "quiet");
  assert.equal(status(usgs, quiet(900)), "stale");
  // Checked recently but last succeeded long ago: stale data, even without an error now.
  assert.equal(status(usgs, { checked_at: ago(30), last_success_at: ago(7200), error: null }), "stale");
  assert.equal(status(usgs, { checked_at: ago(30), last_success_at: null, error: null }), "stale");
  assert.equal(status(usgs, null), "stale");
});

test("the latest read failing is failing, but an error from a check long ago means the collector stopped: stale", () => {
  assert.equal(status(usgs, { checked_at: ago(60), last_success_at: ago(400), error: "source_http_503" }), "failing");
  // A recent success does not hide that the latest read failed.
  assert.equal(status(usgs, { checked_at: ago(10), last_success_at: ago(70), error: "source_http_503" }), "failing");
  assert.equal(status(usgs, { checked_at: ago(3600), last_success_at: ago(4000), error: "source_http_503" }), "stale");
});

test("disabled or credential-gated sources are not configured, licence-pending ones access unresolved, and a pending permission is carried", () => {
  const fresh = { checked_at: ago(60), last_success_at: ago(60), error: null, checkpoint: { accepted_items: { a: "x" } } };
  assert.equal(status(source("uk-tfl-roads"), fresh), "not_configured");
  assert.equal(status(source("fr-sncf-siri"), fresh), "not_configured");
  assert.equal(status(source("it-dpc-notizia"), fresh), "not_configured");
  assert.equal(status(source("meteoalarm-it"), fresh), "access_unresolved");
  const routing = sourceCoverage(source("global-ripestat-routing"), fresh, now);
  assert.equal(routing.status, "observed");
  assert.match(routing.unresolved!, /RIPE NCC logo/);
  assert.match(sourceCoverage(source("global-gdelt-news-english"), fresh, now).unresolved!, /model use/);
  assert.match(sourceCoverage(source("global-adsblol-emergency-squawks"), fresh, now).unresolved!, /contact it first/);
  assert.equal(sourceCoverage(usgs, fresh, now).unresolved, null);
});

test("a sensor the issuer ended reads ended, not empty or stale; the others keep their own status", () => {
  const layer = { checked_at: ago(120), cadence_seconds: 600 };
  assert.equal(layerCoverage({ status: "ended", total_available: 0 }, layer, now), "ended");
  assert.equal(layerCoverage({ status: "ended", total_available: 0 }, { ...layer, checked_at: ago(86400) }, now), "ended");
  assert.equal(layerCoverage({ status: "ok", total_available: 12 }, layer, now), "observed");
  assert.equal(layerCoverage({ status: "ok", total_available: 0 }, layer, now), "quiet");
  assert.equal(layerCoverage({ status: "error", total_available: 0 }, layer, now), "failing");
  assert.equal(layerCoverage({ status: "ok", total_available: 12 }, { ...layer, checked_at: ago(1201) }, now), "stale");
});

test("issuer lag skips a first read's backlog, uses the issuer's update time and clamps clock skew", () => {
  const records = [
    { published_at: null, source_updated_at: ago(90) },
    { published_at: ago(600), source_updated_at: null },
    { published_at: null, source_updated_at: null },
    { published_at: null, source_updated_at: new Date(now + 5000).toISOString() },
  ];
  assert.deepEqual(issuerLag(records, null, now), []);
  assert.deepEqual(issuerLag(records, ago(300), now), [
    [ago(0), 90],
    [ago(0), 600],
    [ago(0), 0],
  ]);
  const old: LagSample = [ago(LAG_WINDOW_SECONDS + 1), 5];
  const many = Array.from({ length: LAG_SAMPLES + 10 }, (_, n): LagSample => [ago(LAG_SAMPLES + 10 - n), n]);
  const kept = keepLag([old, ...many], now);
  assert.equal(kept.length, LAG_SAMPLES);
  assert.deepEqual(kept[0], [ago(LAG_SAMPLES), 10]);
  assert.deepEqual(kept.at(-1), [ago(1), LAG_SAMPLES + 9]);
});

test("latency percentiles are nearest-rank medians and 90th percentiles, null without samples", () => {
  assert.deepEqual(summarise([]), { n: 0, p50: null, p90: null });
  assert.deepEqual(summarise([42]), { n: 1, p50: 42, p90: 42 });
  assert.deepEqual(summarise([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), { n: 10, p50: 5, p90: 9 });
  assert.deepEqual(summarise([3, 1, 2]), { n: 3, p50: 2, p90: 3 });
});

test("ingest to publication is zero for structured records, the analysis delay for narrative ones, and skips fused or old incidents", () => {
  const incident = (sources: string[], ingested: number, analyzed: number | null) =>
    ({
      reports: sources.map((source_id) => ({ source_id })),
      ingested_at: ago(ingested),
      analyzed_at: analyzed === null ? null : ago(analyzed),
    }) as unknown as IncidentView;
  const lag = publicationLag(
    [
      incident(["global-usgs-earthquakes"], 600, null),
      incident(["no-politiloggen"], 900, 300),
      incident(["no-politiloggen"], 3600, 3000),
      incident(["no-politiloggen", "se-polisen-events"], 600, 60),
      incident(["no-politiloggen"], LAG_WINDOW_SECONDS + 60, 60),
    ],
    now,
  );
  assert.deepEqual(Object.fromEntries(lag), {
    "global-usgs-earthquakes": [0],
    "no-politiloggen": [600, 600],
  });
  assert.deepEqual(
    sourceLatency({ checkpoint: { issuer_lag: [[ago(60), 30], [ago(30), 90], [ago(LAG_WINDOW_SECONDS + 1), 9999]] } }, lag.get("no-politiloggen"), now),
    { issuer_to_ingest: { n: 2, p50: 30, p90: 90 }, ingest_to_publication: { n: 2, p50: 600, p90: 600 } },
  );
});

test("coverage copy is translated into Italian", () => {
  for (const text of [
    "Observed", "Quiet", "Stale", "Failing", "Ended", "Not configured", "Access unresolved",
    "Read on schedule and listing records.", "Read on schedule and listing nothing.",
    "No successful read within two expected intervals.", "The latest read failed.",
    "The issuer stopped delivering this data.", "Not read: disabled or awaiting credentials.",
    "A licence or permission is not settled yet.", "No reports",
    "A source that covers the place read it on schedule and listed nothing there.", "Not covered",
    "No source being read covers the place or layer, so an empty map there says nothing.",
    "Issuer to ingest", "Ingest to publication", "Latency", "no samples yet", "median", "expected every", "never",
    "Delivery ended", "Issuer notice", "in this view", "Not read",
    "Satellite sensors and mapping areas are checked while their layer is on.",
    "No source being read covers this country, so no reports here means not covered.",
    "Source scope does not establish complete local coverage. Open the coverage view for every source's status and what silence means.",
    "Sources read successfully on schedule", "sources fresh",
  ])
    assert.notEqual(translate("it", text), text, text);
});

test("the collector keeps issuer-lag samples for new and changed records after its first read, bounded in the checkpoint", async () => {
  const feed = JSON.parse(readFileSync("tests/fixtures/usgs-summary.json", "utf8"));
  const start = Date.now();
  let body = feed,
    clock = start,
    checkpoint: FetchState = {};
  const run = () =>
    collectSources(
      { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "isolated-fixture" },
      {
        sources: [usgs],
        register: async () => {},
        checkpoint: async () => checkpoint,
        ingest: async () => {},
        recordHealth: async (_, h) => {
          checkpoint = h.checkpoint;
        },
        fetch: async (input) => {
          assert.equal(String(input), USGS_FEED_URL);
          return Response.json(body);
        },
        now: () => clock,
      },
    );
  await run();
  assert.equal(Object.keys(checkpoint.accepted_items!).length, feed.features.length);
  assert.deepEqual(checkpoint.issuer_lag, [], "the first read is backlog, not latency");
  clock = start + 600000;
  body = structuredClone(feed);
  body.features[0].properties.updated = clock - 120000;
  await run();
  assert.deepEqual(checkpoint.issuer_lag, [[new Date(clock).toISOString(), 120]]);
  assert.equal(
    sourceCoverage(usgs, { checked_at: new Date(clock).toISOString(), last_success_at: new Date(clock).toISOString(), checkpoint }, clock).status,
    "observed",
  );
});

test("the snapshot already carries every input coverage and latency need, with no extra or unbounded read", async () => {
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
      async first() {
        const result = db.prepare(sql).get(...values) ?? null;
        reads.push({ sql, rows: result ? 1 : 0 });
        return result;
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
    assert.equal(response.status, 200, path);
    return { rowsRead: Number(response.headers.get("x-ew-rows-read")), body: (await response.json()) as any };
  };
  try {
    const sources = sourceRegistry;
    for (let i = 0; i < sources.length; i += 40)
      await api("/api/sources", { sources: sources.slice(i, i + 40) }, "fixture-collector");
    const time = new Date().toISOString();
    const lag: LagSample[] = Array.from({ length: LAG_SAMPLES }, (_, n) => [time, 60 + n]);
    const enabled = sources.filter((s) => s.status === "enabled");
    for (const s of enabled)
      await api(
        `/api/sources/${s.id}/health`,
        { checked_at: time, last_success_at: time, received: 1, checkpoint: { accepted_items: { a: "x" }, issuer_lag: lag } },
        "fixture-collector",
      );
    const { parseUsgs } = await import("../src/collector/adapters/usgs.js");
    const rows = parseUsgs(usgs, JSON.parse(readFileSync("tests/fixtures/usgs-summary.json", "utf8")));
    for (let i = 0; i < rows.length; i += 3)
      await api("/api/ingest", { observations: rows.slice(i, i + 3) }, "fixture-collector");
    reads.length = 0;
    const snapshot = await api("/api/snapshot?hours=0&view=list");
    // One health row per registered source, read in the join the snapshot already made.
    const health = reads.filter((r) => /source_health/.test(r.sql));
    assert.deepEqual(
      health.map((r) => r.rows),
      [enabled.length, sources.length],
      "the status health read and the source list join, nothing per source",
    );
    // Incidents, the source registry, queued reports, the cursor and status, then the source list.
    assert.equal(reads.length, 10, reads.map((r) => r.sql).join("\n"));
    assert(!reads.some((r) => /issuer_lag|news_files|json_extract\(h\./.test(r.sql)));
    const incidents: IncidentView[] = snapshot.body.incidents;
    assert.equal(incidents.length, rows.length);
    assert(
      snapshot.rowsRead <= 2 * incidents.length + 3 * sources.length + 2,
      `snapshot read ${snapshot.rowsRead} rows for ${incidents.length} incidents and ${sources.length} sources`,
    );
    const published = publicationLag(incidents, Date.now());
    const usgsRow = snapshot.body.sources.find((s: any) => s.id === usgs.id);
    assert.equal(sourceCoverage(usgsRow, usgsRow.health).status, "observed");
    assert.deepEqual(sourceLatency(usgsRow.health, published.get(usgs.id), Date.now()), {
      issuer_to_ingest: { n: LAG_SAMPLES, p50: 84, p90: 104 },
      ingest_to_publication: { n: rows.length, p50: 0, p90: 0 },
    });
    // Each report carries the issuer's own update time, so a stateless public run can measure lag too.
    assert(incidents.every((i) => i.reports[0].source_updated_at));
  } finally {
    db.close();
  }
});
