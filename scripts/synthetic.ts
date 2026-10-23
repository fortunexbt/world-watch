// Synthetic worldwide workload for the offline performance harnesses. The
// trimmed USGS, GDACS, NWS and ECCC fixtures go through the real adapters, are
// moved, re-timed and renumbered, then published through the real ingest path,
// so stored views have the shapes production writes. Nothing here is a real
// event, and nothing is fetched.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { parseUsgs } from "../src/collector/adapters/usgs.js";
import { parseGdacs } from "../src/collector/adapters/gdacs.js";
import { parseNws } from "../src/collector/adapters/nws.js";
import { parseEccc } from "../src/collector/adapters/eccc.js";
import { sourceRegistry } from "../src/collector/registry.js";
import type { ObservationInput } from "../src/shared/contracts.js";
import type { Env } from "../src/server/index.js";

const root = path.resolve(import.meta.dirname, "..");
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(root, "tests/fixtures", name), "utf8"));
const source = (id: string) => sourceRegistry.find((s) => s.id === id)!;
const templates = {
  usgs: parseUsgs(source("global-usgs-earthquakes"), fixture("usgs-summary.json")),
  gdacs: parseGdacs(source("global-gdacs-alerts"), fixture("gdacs-events.json")),
  nws: parseNws(source("us-nws-warnings"), fixture("nws-alerts.json")),
  eccc: parseEccc(source("ca-eccc-warnings"), fixture("eccc-alerts.json")),
};
type Kind = keyof typeof templates;

/** Deterministic PRNG (mulberry32), so a seed reproduces the same store. */
export function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) =>
  Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Busy regions, two of them straddling the antimeridian, over a sparse worldwide background. */
export const REGIONS: {
  name: string;
  lon: number;
  lat: number;
  spread: [number, number];
  weight: number;
  kinds: Kind[];
}[] = [
  { name: "conus", lon: -95, lat: 38, spread: [12, 6], weight: 25, kinds: ["nws"] },
  { name: "canada", lon: -100, lat: 56, spread: [16, 7], weight: 10, kinds: ["eccc"] },
  { name: "japan", lon: 139, lat: 36, spread: [4, 4], weight: 8, kinds: ["usgs"] },
  { name: "indonesia", lon: 118, lat: -3, spread: [8, 4], weight: 7, kinds: ["usgs", "gdacs"] },
  { name: "europe", lon: 12, lat: 48, spread: [10, 6], weight: 6, kinds: ["gdacs"] },
  { name: "south-asia", lon: 82, lat: 24, spread: [6, 5], weight: 5, kinds: ["gdacs", "usgs"] },
  { name: "fiji-tonga", lon: 179.5, lat: -18, spread: [3, 3], weight: 4, kinds: ["usgs"] },
  { name: "chile", lon: -71, lat: -30, spread: [2, 8], weight: 4, kinds: ["usgs"] },
  { name: "aleutians", lon: -178, lat: 52, spread: [8, 1.5], weight: 3, kinds: ["usgs"] },
  { name: "background", lon: 0, lat: 0, spread: [0, 0], weight: 8, kinds: ["usgs", "gdacs"] },
];
const totalWeight = REGIONS.reduce((n, r) => n + r.weight, 0);
function place(r: () => number) {
  let pick = r() * totalWeight;
  const region = REGIONS.find((g) => (pick -= g.weight) < 0) ?? REGIONS[0];
  if (region.name === "background")
    return { region, lon: r() * 360 - 180, lat: r() * 135 - 60 };
  return {
    region,
    lon: wrap(region.lon + gauss(r) * region.spread[0]),
    lat: Math.max(-80, Math.min(84, region.lat + gauss(r) * region.spread[1])),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const round = (v: number) => Math.round(v * 1e4) / 1e4;
/** One issuer record for synthetic incident `n`, revision `v`, issued at `t`. */
function observation(
  kind: Kind,
  n: number,
  v: number,
  t: number,
  lon: number,
  lat: number,
  r: () => number,
  current: boolean,
): ObservationInput {
  const list = templates[kind],
    base = structuredClone(list[n % list.length]) as ObservationInput;
  const record = JSON.parse(base.excerpts[0].text);
  const start = t - Math.floor(r() * 2 * 3600000),
    hours = kind === "nws" ? 1 + r() * 5 : kind === "eccc" ? 12 + r() * 24 : 72 + r() * 240;
  const end = kind === "usgs" || current ? null : iso(start + hours * 3600000);
  if (kind === "usgs") {
    record.magnitude = Math.round((4.5 + r() ** 3 * 3) * 10) / 10;
    record.origin_time = iso(start);
  } else if (kind === "gdacs") {
    record.from = iso(start);
    record.to = end ?? iso(t);
  } else if (kind === "nws") {
    record.sent = record.onset = iso(start);
    record.ends = record.expires = end;
  } else {
    record.issued = record.valid_from = iso(start);
    record.event_end = record.message_expires = end;
  }
  record.source_updated_at = iso(t);
  if (v > 1) record.update = v;
  const id = `syn-${kind}-${n}`;
  const url = new URL(base.canonical_url);
  url.searchParams.set("synthetic", `${n}.${v}`);
  return {
    ...base,
    native_id: v > 1 ? `${id}.${v}` : id,
    source_event_id: id,
    canonical_url: url.href,
    title: `${base.title} (synthetic ${n})`,
    published_at: base.published_at === null ? null : iso(t),
    source_updated_at: iso(t),
    excerpts: [{ ...base.excerpts[0], text: JSON.stringify(record) }],
    source_geo: { ...base.source_geo!, lon: round(lon), lat: round(lat) },
    official: {
      ...base.official!,
      effective_at: iso(start),
      expires_at: end,
      ...(kind === "gdacs" ? { current_listing: current } : {}),
    },
  };
}

/** `count` new issuer records at `at`, numbered past any seeded incident. */
export function burst(count: number, seed: number, at = Date.now()) {
  const r = random(seed);
  return Array.from({ length: count }, (_, k) => {
    const p = place(r),
      kind = p.region.kinds[Math.floor(r() * p.region.kinds.length)];
    return observation(kind, 1e9 + seed * 1e5 + k, 1, at, p.lon, p.lat, r, false);
  });
}

/** A D1 binding over node:sqlite for seeding: batches are transactions, as on D1. */
export function sqliteD1(db: DatabaseSync) {
  const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  const prepared = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const value = (v: unknown) =>
    (v === undefined ? null : typeof v === "boolean" ? Number(v) : v) as SQLInputValue;
  const statement = (sql: string, values: SQLInputValue[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next.map(value)),
    all: async () => ({ results: prepared(sql).all(...values), meta: {} }),
    first: async () => prepared(sql).get(...values) ?? null,
    run: async () => ({ meta: prepared(sql).run(...values) }),
    sql,
    values,
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(list: { sql: string; values: SQLInputValue[] }[]) {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => ({ results: prepared(s.sql).all(...s.values), meta: {} }));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export const OWNER = "synthetic-owner",
  COLLECTOR = "synthetic-collector",
  WORKER = "synthetic-worker";
export const env = (DB: unknown) =>
  ({
    DB,
    ASSETS: { fetch: async () => new Response("asset") },
    STORAGE_PAUSED: "0",
    EUROPE_WATCH_OWNER_TOKEN: OWNER,
    EUROPE_WATCH_COLLECTOR_TOKEN: COLLECTOR,
    EUROPE_WATCH_WORKER_TOKEN: WORKER,
  }) as unknown as Env;

/**
 * Runs `body` with Date reading `clock()`, so ingest stamps records at their synthetic issue time,
 * and with SHA-256 computed inline: the same digest without a thread-pool round trip per hash.
 */
async function atClock<T>(clock: () => number, body: () => Promise<T>) {
  const Real = Date,
    digest = crypto.subtle.digest;
  class Clocked extends Real {
    constructor(...args: any[]) {
      if (args.length) super(...(args as [any]));
      else super(clock());
    }
    static now() {
      return clock();
    }
  }
  globalThis.Date = Clocked as DateConstructor;
  crypto.subtle.digest = async (_: AlgorithmIdentifier, data: BufferSource) =>
    new Uint8Array(
      createHash("sha256")
        .update(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data))
        .digest(),
    ).buffer;
  try {
    return await body();
  } finally {
    globalThis.Date = Real;
    crypto.subtle.digest = digest;
  }
}

export type SeedOptions = {
  incidents: number;
  /** Share of incidents the issuer later revises, each one to four times. */
  revised: number;
  rules: number;
  days: number;
  seed: number;
  end?: number;
  onProgress?: (done: number, total: number) => void;
};
/** Seeds a migrated store through the real ingest path and returns what it wrote. */
export async function seedStore(db: DatabaseSync, options: SeedOptions) {
  const { ingest } = await import("../src/server/index.js");
  const r = random(options.seed),
    end = options.end ?? Date.now(),
    start = end - options.days * 86400000;
  db.exec("PRAGMA foreign_keys=ON");
  const insertSource = db.prepare("INSERT OR REPLACE INTO sources(id,record) VALUES(?,?)");
  for (const s of sourceRegistry) insertSource.run(s.id, JSON.stringify(s));
  for (const id of ["global-usgs-earthquakes", "global-gdacs-alerts", "us-nws-warnings", "ca-eccc-warnings"])
    db.prepare("INSERT OR REPLACE INTO source_health(source_id,checked_at,last_success_at,received) VALUES(?,?,?,?)").run(id, iso(end), iso(end), 100);
  for (let k = 0; k < options.rules; k++) {
    const g = REGIONS[k % (REGIONS.length - 1)],
      w = Math.max(2, g.spread[0]),
      h = Math.max(2, g.spread[1]);
    db.prepare("INSERT INTO watch_areas(id,owner_id,geometry,name,created_at) VALUES(?,'owner',?,?,?)").run(
      `area-${k}`,
      JSON.stringify({ bbox: [wrap(g.lon - w), Math.max(-89, g.lat - h), wrap(g.lon + w), Math.min(89, g.lat + h)] }),
      `${g.name} ${k}`,
      iso(start),
    );
    db.prepare("INSERT INTO alert_rules(id,owner_id,version,rule) VALUES(?,'owner',1,?)").run(
      `rule-${k}`,
      JSON.stringify({ name: `Synthetic ${k}`, watch_area_id: `area-${k}`, impacts: k % 2 ? ["significant", "severe", "critical"] : undefined, cooldown_minutes: 30 }),
    );
  }
  const kinds: Kind[] = [];
  const events: { t: number; n: number; v: number; lon: number; lat: number }[] = [];
  for (let n = 0; n < options.incidents; n++) {
    const p = place(r),
      kind = p.region.kinds[Math.floor(r() * p.region.kinds.length)],
      t = start + r() * (end - start);
    kinds.push(kind);
    events.push({ t, n, v: 1, lon: p.lon, lat: p.lat });
    if (r() < options.revised) {
      const count = 1 + Math.floor(r() * 4);
      for (let v = 2, at = t; v <= count + 1; v++) {
        at += 600000 + r() * 6 * 3600000;
        if (at < end) events.push({ t: at, n, v, lon: p.lon, lat: p.lat });
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  // GDACS lists a few dozen current events at a time; older ones have ended.
  const currentGdacs = new Set(
    events.filter((e) => e.v === 1 && kinds[e.n] === "gdacs").slice(-60).map((e) => e.n),
  );
  // The search index is rebuilt once at the end, as its migration builds it, rather than
  // maintained per ingest; the triggers are restored exactly as the migrations wrote them.
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'incidents_search_%'")
    .all() as { name: string; sql: string }[];
  for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
  const env_ = env(sqliteD1(db));
  const week = end - 7 * 86400000;
  const outboxHead = () => Number((db.prepare("SELECT coalesce(max(id),0) AS id FROM outbox").get() as any).id);
  let clock = start,
    stale: number | undefined;
  await atClock(
    () => clock,
    async () => {
      for (let k = 0; k < events.length; k++) {
        const e = events[k];
        // The outbox stamps rows with the database clock, so its seven-day cut is found by id.
        if (e.t >= week && stale === undefined) stale = outboxHead();
        clock = e.t;
        await ingest(env_, [
          observation(kinds[e.n], e.n, e.v, e.t, e.lon, e.lat, r, currentGdacs.has(e.n)),
        ]);
        if (k % 5000 === 0) options.onProgress?.(k, events.length);
      }
    },
  );
  db.exec("DELETE FROM incidents_fts");
  db.exec("INSERT INTO incidents_fts(incident_id,search_text) SELECT id,view FROM incidents WHERE deleted_at IS NULL");
  for (const t of triggers) db.exec(t.sql);
  // The scheduled handler keeps seven days of outbox.
  db.prepare("DELETE FROM outbox WHERE id<=?").run(stale ?? outboxHead());
  const count = (sql: string) => Number((db.prepare(sql).get() as any).n);
  return {
    incidents: count("SELECT count(*) AS n FROM incidents"),
    revisions: count("SELECT count(*) AS n FROM incident_revisions"),
    observations: count("SELECT count(*) AS n FROM observations"),
    outbox: count("SELECT count(*) AS n FROM outbox"),
    alert_deliveries: count("SELECT count(*) AS n FROM alert_deliveries"),
    sources: count("SELECT count(*) AS n FROM sources"),
    rules: options.rules,
    regions: Object.fromEntries(REGIONS.map((g) => [g.name, g.weight / totalWeight])),
  };
}

/**
 * `count` published incident views, newest first, as the snapshot returns them. Up to `seeded`
 * come from a real in-memory ingest; the rest copy those with new ids and places.
 */
export async function views(count: number, seed: number, seeded = 2000) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  migrate(db);
  await seedStore(db, { incidents: Math.min(count, seeded), revised: 0.25, rules: 0, days: 7, seed });
  const base = db
    .prepare("SELECT view FROM incidents ORDER BY updated_at DESC")
    .all()
    .map((row: any) => JSON.parse(row.view));
  db.close();
  const r = random(seed + 1);
  const out = [...base];
  for (let k = base.length; k < count; k++) {
    const copy = structuredClone(base[k % base.length]),
      p = place(r);
    copy.id = `${copy.id.slice(0, 48)}${k.toString(16).padStart(16, "0")}`;
    copy.location = { ...copy.location, lon: round(p.lon), lat: round(p.lat) };
    out.push(copy);
  }
  return out;
}

/** Applies the committed migrations to an empty node:sqlite database. */
export function migrate(db: DatabaseSync) {
  const dir = path.join(root, "deploy/migrations");
  for (const file of readdirSync(dir).sort())
    db.exec(readFileSync(path.join(dir, file), "utf8"));
}

/** Three FIRMS-shaped 24 h global files, clustered over fire-prone regions, `total` rows in all. */
export function thermalFiles(total: number, seed: number, now = Date.now()) {
  const r = random(seed);
  const fires = [
    { lon: 22, lat: -10, spread: [10, 6], weight: 30 },
    { lon: 10, lat: 9, spread: [12, 3], weight: 20 },
    { lon: -55, lat: -10, spread: [10, 6], weight: 15 },
    { lon: 102, lat: 15, spread: [6, 5], weight: 12 },
    { lon: 135, lat: -18, spread: [12, 5], weight: 8 },
    { lon: 120, lat: 60, spread: [20, 5], weight: 5 },
    { lon: -120, lat: 40, spread: [6, 5], weight: 4 },
    { lon: 178, lat: 64, spread: [4, 2], weight: 1 },
  ];
  const background = 5;
  const weight = fires.reduce((n, f) => n + f.weight, background);
  const header =
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n";
  return ["N20", "N21", "N"].map((satellite) => {
    const rows: string[] = [];
    for (let k = 0; k < Math.round(total / 3); k++) {
      let pick = r() * weight;
      const f = fires.find((x) => (pick -= x.weight) < 0);
      const lon = f ? wrap(f.lon + gauss(r) * f.spread[0]) : r() * 360 - 180,
        lat = f ? Math.max(-60, Math.min(80, f.lat + gauss(r) * f.spread[1])) : r() * 120 - 55,
        at = new Date(now - 60000 - r() * 86000000).toISOString(),
        c = r(),
        confidence = c < 0.15 ? "low" : c < 0.85 ? "nominal" : "high";
      rows.push(
        `${lat.toFixed(5)},${lon.toFixed(5)},330.1,0.4,0.37,${at.slice(0, 10)},${at.slice(11, 13)}${at.slice(14, 16)},${satellite},VIIRS,${confidence},2.0NRT,290.4,3.1,D`,
      );
    }
    return header + rows.join("\n") + "\n";
  });
}
