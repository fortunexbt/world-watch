// Offline server load harness. Seeds a throwaway local D1 store (the Miniflare
// engine `wrangler dev` uses) with the synthetic worldwide workload in
// scripts/synthetic.ts, then calls the Worker's fetch handler in this process
// against it. D1 rows read come from the engine's own query metadata; handler
// CPU is this thread's CPU time. Nothing is deployed or fetched, and the store
// is deleted on exit unless --save-store names a directory to keep it in.
//
//   npm run perf:load -- --incidents=100000 --runs=7 --out=/tmp/ww-load.json
//   npm run perf:load -- --store=/tmp/ww-store --runs=7   (reuse a saved store)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { getPlatformProxy } from "wrangler";
import { CEMS_URL, FIRMS_SENSORS, getThermalIndex } from "../src/server/geospatial.js";
import { occupiedTiles } from "../src/server/thermal-tiles.js";
import {
  burst,
  COLLECTOR,
  env as envFor,
  OWNER,
  seedStore,
  thermalFiles,
} from "./synthetic.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "1"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const option = (k: string, fallback: number) => Number(args[k] ?? fallback);
const settings = {
  incidents: option("incidents", 100000),
  revised: option("revised", 0.25),
  rules: option("rules", 20),
  days: option("days", 30),
  thermal: option("thermal", 200000),
  runs: option("runs", 7),
  streams: option("streams", 10),
  burst: option("burst", 60),
  seed: option("seed", 1),
};
const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "world-watch-load-"));
const state = path.join(temp, "state");
// Seeding swaps Date for a synthetic clock, so log time comes from the process clock.
const startedAt = Date.now() - performance.now();
const log = (...v: unknown[]) =>
  console.error(new Date(startedAt + performance.now()).toISOString().slice(11, 19), ...v);
const load = () => Number(loadavg()[0].toFixed(1));

const config = {
  name: "world-watch-load",
  main: path.join(root, "src/server/index.ts"),
  compatibility_date: "2026-10-21",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [
    {
      binding: "DB",
      database_name: "europe-watch",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: path.join(root, "deploy/migrations"),
    },
  ],
};
const configPath = path.join(temp, "wrangler.json");
await writeFile(configPath, JSON.stringify(config));
let proxy: Awaited<ReturnType<typeof getPlatformProxy>> | undefined;
try {
  if (args.store) cpSync(args.store, state, { recursive: true });
  // On a reused store this applies only the migrations it lacks, timed as a deployment would run them.
  const migrating = performance.now();
  execFileSync(
    path.join(root, "node_modules/.bin/wrangler"),
    ["d1", "migrations", "apply", "europe-watch", "--local", "--persist-to", state, "--config", configPath],
    { cwd: temp, stdio: "ignore", env: { ...process.env, CI: "1" } },
  );
  const migrateSeconds = Math.round(performance.now() - migrating) / 1000;
  const dir = path.join(state, "v3/d1/miniflare-D1DatabaseObject");
  const file = path.join(dir, readdirSync(dir).find((f) => /^[0-9a-f]{64}\.sqlite$/.test(f))!);
  let seeded: unknown = null;
  if (!args.store) {
    log(`seeding ${settings.incidents} incidents`);
    const db = new DatabaseSync(file);
    // A throwaway store needs no fsync per ingest batch.
    db.exec("PRAGMA synchronous=OFF");
    const started = performance.now();
    seeded = {
      ...(await seedStore(db, {
        ...settings,
        onProgress: (n, total) => log(`ingested ${n}/${total}`),
      })),
      seconds: Math.round((performance.now() - started) / 1000),
    };
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    log("seeded", seeded);
    if (args["save-store"]) cpSync(state, args["save-store"], { recursive: true });
  }
  const db = new DatabaseSync(file, { readOnly: true });
  const store = Object.fromEntries(
    ["incidents", "incident_revisions", "observations", "outbox", "alert_deliveries", "alert_rules", "sources"].map((t) => [
      t,
      Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as any).n),
    ]),
  );
  db.close();

  // Synthetic FIRMS files and an empty Copernicus list stand in for the upstream fetches.
  const thermal = thermalFiles(settings.thermal, settings.seed);
  const upstream = async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const k = FIRMS_SENSORS.findIndex((s) => s.url === url);
    if (k >= 0) return new Response(thermal[k], { headers: { "content-type": "text/csv" } });
    if (url === CEMS_URL) return Response.json({ results: [] });
    throw Error("load_harness_blocks_network: " + url);
  };
  globalThis.fetch = upstream as typeof fetch;

  proxy = await getPlatformProxy({
    configPath,
    persist: { path: path.join(state, "v3") },
    remoteBindings: false,
    envFiles: [],
  });
  const d1 = (proxy.env as any).DB;
  const { default: server } = await import("../src/server/index.js");
  const totals = { read: 0, written: 0, queries: 0 };
  // A new wrapper is a new isolate as far as the Worker's per-binding caches are concerned.
  const binding = () => {
    const note = (result: any) => {
      totals.queries++;
      totals.read += result?.meta?.rows_read ?? 0;
      totals.written += result?.meta?.rows_written ?? 0;
      return result;
    };
    const wrap = (s: any): any => ({
      inner: s,
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      all: async () => note(await s.all()),
      run: async () => note(await s.run()),
      first: async () => (await s.all().then(note)).results[0] ?? null,
    });
    return {
      prepare: (sql: string) => wrap(d1.prepare(sql)),
      batch: async (list: any[]) => (await d1.batch(list.map((s) => s.inner))).map(note),
    };
  };
  let isolate = envFor(binding());
  const fresh = () => (isolate = envFor(binding()));

  type Sample = Record<string, number>;
  async function call(
    pathname: string,
    init: { token?: string; method?: string; body?: unknown } = {},
  ): Promise<{ text: string; sample: Sample }> {
    const request = new Request("http://load.invalid" + pathname, {
      method: init.method ?? "GET",
      headers: {
        authorization: "Bearer " + (init.token ?? OWNER),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const before = { ...totals },
      cpu = process.threadCpuUsage(),
      t = performance.now();
    const response = await server.fetch(request, isolate);
    const body = new Uint8Array(await response.arrayBuffer()),
      text = new TextDecoder().decode(body);
    const ms = performance.now() - t,
      used = process.threadCpuUsage(cpu);
    if (!response.ok) throw Error(`${pathname}: ${response.status} ${text.slice(0, 200)}`);
    return {
      text,
      sample: {
        ms,
        cpu_ms: (used.user + used.system) / 1000,
        rows_read: totals.read - before.read,
        rows_written: totals.written - before.written,
        queries: totals.queries - before.queries,
        bytes: body.length,
        load: load(),
      },
    };
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b),
      m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const percentile = (v: number[], p: number) => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  };
  const summarise = (samples: Sample[]) => {
    const out: Record<string, number> = { runs: samples.length };
    for (const k of Object.keys(samples[0])) {
      const v = samples.map((s) => s[k]);
      out[k] = Math.round(median(v) * 10) / 10;
      if (["ms", "cpu_ms", "load"].includes(k)) {
        out[k + "_min"] = Math.round(Math.min(...v) * 10) / 10;
        out[k + "_max"] = Math.round(Math.max(...v) * 10) / 10;
      }
    }
    return out;
  };
  const results: Record<string, Record<string, number>> = {};

  // Viewports the client asks for. Each warm run follows the others, so the one-second incident
  // memo has expired while the sixty-second status cache still holds, as in a live isolate.
  const viewports: Record<string, string> = {
    "world 168h": "hours=168",
    "world 24h": "hours=24",
    "world all": "hours=0",
    "europe 24h": "hours=24&bbox=-12,34,32,62",
    "europe 168h": "hours=168&bbox=-12,34,32,62",
    "conus 24h": "hours=24&bbox=-125,24,-66,50",
    "japan 24h": "hours=24&bbox=128,30,146,46",
    "fiji dateline 24h": "hours=24&bbox=170,-25,-170,-10",
    "fiji dateline all": "hours=0&bbox=170,-25,-170,-10",
    "aleutians dateline 168h": "hours=168&bbox=170,45,-160,60",
    "sahara quiet 168h": "hours=168&bbox=-5,15,30,30",
    "search earthquake 168h": "hours=168&q=earthquake",
  };
  // The client asks for list views; the detail endpoint serves a selected incident.
  const snapshotPath = (q: string) => `/api/snapshot?include_incoming=0&view=list&${q}`;
  log("snapshot viewports");
  await call(snapshotPath("hours=168"));
  const viewportSamples: Record<string, Sample[]> = {};
  const failures: Record<string, string[]> = {};
  const lastRun = new Map<string, number>();
  for (let run = 0; run < settings.runs; run++)
    for (const [name, q] of Object.entries(viewports)) {
      await sleep(Math.max(0, 1100 - (performance.now() - (lastRun.get(name) ?? 0))));
      // A failed read is a result: count it and keep measuring the other viewports.
      const outcome = await call(snapshotPath(q)).catch((error) => {
        (failures[name] ??= []).push(String(error).slice(0, 200));
        return null;
      });
      lastRun.set(name, performance.now());
      if (!outcome) continue;
      const { text, sample } = outcome;
      const body = JSON.parse(text);
      (viewportSamples[name] ??= []).push({
        ...sample,
        gzip_bytes: gzipSync(text).length,
        incidents: body.incidents.length,
        limited: body.limited ? 1 : 0,
      });
    }
  for (const name of Object.keys(viewports))
    results[`snapshot ${name}`] = {
      ...(viewportSamples[name] ? summarise(viewportSamples[name]) : { runs: 0 }),
      failed: failures[name]?.length ?? 0,
    };

  // Replay: what the store knew an hour, a day, a week and three weeks before its last revision.
  log("replay snapshots");
  const known = await d1.prepare("SELECT max(known_at) AS last FROM incident_revisions").first();
  const replays = ["world 168h", "world 24h", "europe 24h", "conus 24h", "fiji dateline 24h", "sahara quiet 168h", "search earthquake 168h"];
  for (const [label, back] of [["1 h", 3600000], ["1 d", 86400000], ["7 d", 7 * 86400000], ["21 d", 21 * 86400000]] as const) {
    const at = new Date(Date.parse((known as any).last) - back).toISOString();
    for (const name of replays) {
      const samples: Sample[] = [];
      for (let run = 0; run < settings.runs; run++) {
        const { text, sample } = await call(snapshotPath(`${viewports[name]}&at=${at}`));
        const body = JSON.parse(text);
        samples.push({ ...sample, incidents: body.incidents.length, limited: body.limited ? 1 : 0 });
      }
      results[`replay ${label} back, ${name}`] = summarise(samples);
    }
  }

  log("first snapshot in a new isolate");
  const first: Sample[] = [];
  for (let run = 0; run < settings.runs; run++) {
    fresh();
    const { sample } = await call(snapshotPath("hours=168"));
    first.push(sample);
  }
  results["snapshot world 168h, new isolate"] = summarise(first);

  log("structured brief");
  for (const hours of [24, 168]) {
    const samples: Sample[] = [];
    for (let run = 0; run < settings.runs; run++) {
      fresh();
      await call(snapshotPath(`hours=${hours}`));
      const { sample } = await call(`/api/brief?hours=${hours}`);
      samples.push(sample);
    }
    results[`brief ${hours}h, uncached`] = summarise(samples);
  }

  log("geospatial");
  const cold: Sample[] = [];
  for (let run = 0; run < Math.min(settings.runs, 5); run++) {
    // getGeospatialCatalog caches per fetch function, so a new function is a cold load.
    globalThis.fetch = ((input: RequestInfo | URL) => upstream(input)) as typeof fetch;
    const { sample } = await call("/api/geospatial");
    cold.push(sample);
  }
  results["geospatial world, cold upstream parse"] = summarise(cold);
  const boxes: Record<string, string> = {
    world: "",
    africa: "?bbox=10,-20,35,5",
    europe: "?bbox=-12,34,32,62",
    "chukotka dateline": "?bbox=170,55,-170,70",
  };
  const geoSamples: Record<string, Sample[]> = {};
  for (let run = 0; run < settings.runs; run++)
    for (const [name, q] of Object.entries(boxes)) {
      const { text, sample } = await call("/api/geospatial" + q);
      const body = JSON.parse(text);
      (geoSamples[name] ??= []).push({
        ...sample,
        gzip_bytes: gzipSync(text).length,
        features: body.features.length,
      });
    }
  for (const [name, samples] of Object.entries(geoSamples))
    results[`geospatial ${name}, warm`] = summarise(samples);

  // Thermal tiles: the catalogue load indexes every detection, and each tile is encoded on its
  // first request and then answered from the isolate's copy.
  log("thermal tiles");
  const firstTile: Sample[] = [];
  let version = "";
  for (let run = 0; run < Math.min(settings.runs, 5); run++) {
    globalThis.fetch = ((input: RequestInfo | URL) => upstream(input)) as typeof fetch;
    version = JSON.parse((await call("/api/geospatial")).text).thermal_version;
    firstTile.push((await call(`/api/thermal/${version}/0/0/0`)).sample);
  }
  results["thermal tile 0/0/0, first of a refresh"] = summarise(firstTile);
  const tileSamples: Record<string, Sample[]> = {};
  for (const [z, x, y] of occupiedTiles(await getThermalIndex(globalThis.fetch)))
    for (const pass of ["encoded", "cached"]) {
      const { sample } = await call(`/api/thermal/${version}/${z}/${x}/${y}`);
      (tileSamples[`thermal tiles z${z}, ${pass}`] ??= []).push(sample);
    }
  for (const [name, samples] of Object.entries(tileSamples))
    results[name] = { ...summarise(samples), bytes_total: samples.reduce((n, s) => n + s.bytes, 0) };

  // SSE: streams in this isolate share one outbox read per cursor; separate isolates do not.
  // With `follow`, each stream reads the compact detail of every incident event that does not
  // carry its view, as the client does.
  async function openStreams(count: number, cursor: number, shared: boolean, follow = false) {
    const received: Map<string, number>[] = [];
    const controllers: AbortController[] = [];
    const done: Promise<unknown>[] = [];
    let details = 0;
    for (let k = 0; k < count; k++) {
      const controller = new AbortController(),
        seen = new Map<string, number>(),
        scope = shared ? isolate : envFor(binding());
      controllers.push(controller);
      received.push(seen);
      const response = await server.fetch(
        new Request(`http://load.invalid/api/events?cursor=${cursor}`, {
          headers: { authorization: "Bearer " + OWNER },
          signal: controller.signal,
        }),
        scope,
      );
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      done.push(
        (async () => {
          let buffer = "";
          try {
            for (let r = await reader.read(); !r.done; r = await reader.read()) {
              buffer += r.value;
              for (let cut; (cut = buffer.indexOf("\n\n")) >= 0; ) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                const data = block.match(/^data: (.*)$/m)?.[1];
                const event = data && JSON.parse(data),
                  id = event?.incident_id;
                if (!id || seen.has(id)) continue;
                seen.set(id, performance.now());
                if (follow && !event.incident) {
                  details++;
                  done.push(
                    server
                      .fetch(
                        new Request(`http://load.invalid/api/incidents/${encodeURIComponent(id)}?compact=1`, {
                          headers: { authorization: "Bearer " + OWNER },
                        }),
                        scope,
                      )
                      .then((r) => r.text()),
                  );
                }
              }
            }
          } catch {}
        })(),
      );
    }
    return {
      received,
      details: () => details,
      close: async () => {
        controllers.forEach((c) => c.abort());
        await Promise.all(done);
      },
    };
  }
  const outboxHead = async () =>
    Number(((await d1.prepare("SELECT coalesce(max(id),0) AS id FROM outbox").first()) as any).id);

  /** Issuer revisions of `count` stored structured records: a new message for the same event. */
  const revise = async (count: number, run: number) =>
    (
      await d1
        .prepare(
          "SELECT r.input FROM observations o JOIN observation_revisions r ON r.report_id=o.id AND r.revision=o.latest_revision WHERE o.deleted_at IS NULL ORDER BY o.rowid DESC LIMIT ? OFFSET ?",
        )
        .bind(count, 500 + run * count)
        .all()
    ).results.map((row: any) => {
      const { report_id, content_revision, contract_version, first_observed_at, ingested_at, ...input } = JSON.parse(row.input);
      const record = { ...JSON.parse(input.excerpts[0].text), revised_in_burst: run };
      return {
        ...input,
        native_id: `${input.native_id}.burst${run}`,
        source_updated_at: new Date().toISOString(),
        excerpts: [{ ...input.excerpts[0], text: JSON.stringify(record) }],
      };
    });

  log("ingest burst with live streams");
  const ingestSamples: Sample[] = [],
    projection: number[] = [],
    delivery: number[] = [];
  for (let run = 0; run < Math.min(settings.runs, 5); run++) {
    fresh();
    const cursor = await outboxHead();
    const streams = await openStreams(settings.streams, cursor, true);
    // Two thirds new incidents, one third issuer revisions of stored ones, interleaved.
    const revisions = await revise(Math.floor(settings.burst / 3), run);
    const arrivals = burst(settings.burst - revisions.length, settings.seed * 100 + run);
    const records = arrivals.flatMap((o, k) => (k % 2 && revisions.length ? [o, revisions.pop()!] : [o])).concat(revisions);
    const posted: { start: number; ids: string[] }[] = [];
    const before = { ...totals },
      cpu = process.threadCpuUsage(),
      t = performance.now();
    for (let k = 0; k < records.length; k += 3) {
      const start = performance.now();
      const { sample } = await call("/api/ingest", {
        method: "POST",
        token: COLLECTOR,
        body: { observations: records.slice(k, k + 3) },
      });
      ingestSamples.push({ ...sample, records: Math.min(3, records.length - k) });
      const end = performance.now();
      for (let n = 0; n < Math.min(3, records.length - k); n++) projection.push(end - start);
      posted.push({ start, ids: [] });
    }
    const elapsed = performance.now() - t,
      used = process.threadCpuUsage(cpu);
    // Map each stream arrival back to the POST that carried it, through the outbox entity order.
    const created = (await d1
      .prepare("SELECT entity_id FROM outbox WHERE id>? AND event_type LIKE 'incident.%' ORDER BY id")
      .bind(cursor)
      .all()).results.map((r: any) => r.entity_id as string);
    created.forEach((id: string, n: number) => posted[Math.floor(n / 3)]?.ids.push(id));
    await sleep(2500);
    for (const p of posted)
      for (const id of p.ids)
        for (const seen of streams.received) {
          const at = seen.get(id);
          if (at !== undefined) delivery.push(at - p.start);
        }
    await streams.close();
    results[`ingest burst run ${run + 1}`] = {
      records: records.length,
      seconds: Math.round(elapsed) / 1000,
      records_per_second: Math.round((records.length / elapsed) * 1000 * 10) / 10,
      cpu_ms: Math.round((used.user + used.system) / 1000),
      rows_read: totals.read - before.read,
      rows_written: totals.written - before.written,
      delivered: streams.received.reduce((n, s) => n + s.size, 0),
      expected: created.length * settings.streams,
      load: load(),
    };
  }
  results["ingest POST (3 records)"] = summarise(ingestSamples);
  results["record to projection, ms"] = {
    records: projection.length,
    p50: Math.round(percentile(projection, 50)),
    p95: Math.round(percentile(projection, 95)),
    max: Math.round(Math.max(...projection)),
  };
  results[`record to SSE delivery across ${settings.streams} streams, ms`] = {
    deliveries: delivery.length,
    p50: Math.round(percentile(delivery, 50)),
    p95: Math.round(percentile(delivery, 95)),
    max: Math.round(Math.max(...delivery)),
  };

  log("SSE fan-out catch-up");
  for (const [shared, follow] of [[true, false], [false, false], [false, true]]) {
    for (const count of [1, settings.streams]) {
      const samples: Sample[] = [];
      for (let run = 0; run < Math.min(settings.runs, 5); run++) {
        fresh();
        const head = await outboxHead(),
          cursor = Math.max(0, head - 200);
        const before = { ...totals },
          cpu = process.threadCpuUsage(),
          t = performance.now();
        const streams = await openStreams(count, cursor, shared, follow);
        // One tick delivers up to 200 events per stream; wait for it, then for one idle tick.
        while (streams.received.some((s) => s.size === 0) && performance.now() - t < 10000)
          await sleep(5);
        await sleep(1200);
        await streams.close();
        const used = process.threadCpuUsage(cpu);
        samples.push({
          streams: count,
          outbox_rows: 200,
          incident_events: streams.received[0].size,
          detail_reads: streams.details(),
          cpu_ms: (used.user + used.system) / 1000,
          cpu_us_per_incident_event_per_stream: (used.user + used.system) / (streams.received[0].size * count),
          rows_read: totals.read - before.read,
          queries: totals.queries - before.queries,
          load: load(),
        });
      }
      results[
        `SSE catch-up of 200 outbox rows, ${count} stream${count > 1 ? "s" : ""}, ${shared ? "one isolate" : "isolate each"}${follow ? ", with client detail reads" : ""}`
      ] = summarise(samples);
    }
  }

  const report = { settings, seeded, store, migrate_seconds: migrateSeconds, node: process.version, failures, results };
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await proxy?.dispose();
  await rm(temp, { recursive: true, force: true });
  if (existsSync(temp)) log("could not remove", temp);
}
