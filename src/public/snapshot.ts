// Builds the public demo's static files from live structured sources. The
// collector and the server run in this process against a throwaway in-memory
// database, so publication, rights and brief logic are exactly the API's.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { collectSources, type CollectorResult } from "../collector/index";
import { configuredRegistry } from "../collector/registry";
import { getGeospatialCatalog, WORLD } from "../server/geospatial";
import server, { type Env } from "../server/index";
import { structuredBrief } from "../server/structured-brief";
import type { IncidentView, SourceRecord } from "../shared/contracts";
import {
  issuerLag,
  keepLag,
  layerCoverage,
  publicationLag,
  sourceCoverage,
  sourceLatency,
  type LagSample,
} from "../shared/coverage";
import type { GeospatialCatalog } from "../shared/geospatial";
import { incidentInWindow } from "../shared/temporal";
import {
  BRIEF_WINDOWS,
  MANIFEST,
  PUBLIC_FILE_LIMITS,
  SNAPSHOT_CADENCE_SECONDS,
  type PublicBriefs,
  type PublicFile,
  type PublicIncidents,
  type PublicManifest,
} from "../shared/public-snapshot";

const MIGRATIONS = path.resolve(import.meta.dirname, "../../deploy/migrations");
const ORIGIN = "https://public-snapshot.invalid";
// The collector's default of 40 operations fits one Worker invocation's subrequest limit. Here the API
// is in process and ingests three records per call, so one run needs room for every source at once;
// upstream reads stay bounded per source by max_pages and max_bytes.
const RUN_OPERATIONS = 1000;
/** Thermal and mapping files change about hourly, so a younger catalogue is reused rather than refetched. */
export const GEOSPATIAL_REFRESH_SECONDS = 3600;
/** How long a source's last published records stay up while its reads fail. */
export const CARRY_FORWARD_SECONDS = 3600;

/** The rule the API applies to every incident it shows: each report's source permits access, storage and display. */
export const publicDisplay = (rights: SourceRecord["rights"]) =>
  rights.access && rights.storage && rights.display;
/** Structured hazard sources publish without a model; narrative sources need analysis the demo doesn't run. */
export const PUBLIC_SOURCES = configuredRegistry().filter(
  (s) =>
    s.status === "enabled" &&
    s.config.operational_role === "structured_natural_hazard" &&
    publicDisplay(s.rights),
);

/** A D1-shaped binding over node:sqlite with every deploy migration applied. */
function memoryD1() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(path.join(MIGRATIONS, file), "utf8"));
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
  return {
    db,
    binding: {
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
  };
}

/** A previous catalogue is reused while every layer read succeeded within the refresh interval. */
export function reusableGeospatial(
  previous: GeospatialCatalog | undefined,
  now = Date.now(),
) {
  return (
    !!previous?.sources?.length &&
    previous.sources.every(
      (s) =>
        s.status === "ok" &&
        now - Date.parse(s.checked_at) <
          (GEOSPATIAL_REFRESH_SECONDS - 300) * 1000,
    )
  );
}

/** The published snapshot a run builds on; any part may be missing, as on the first deployment. */
export type PreviousSnapshot = {
  manifest?: PublicManifest;
  incidents?: PublicIncidents;
  geospatial?: GeospatialCatalog;
};

export type PublicSnapshot = {
  manifest: PublicManifest;
  /** Serialised files by name, the manifest included; write the manifest last. */
  files: Map<string, string>;
  results: CollectorResult[];
};

export async function buildPublicSnapshot(
  options: {
    fetch?: typeof fetch;
    resolveHost?: (host: string) => Promise<string[]>;
    sources?: SourceRecord[];
    previous?: PreviousSnapshot;
  } = {},
): Promise<PublicSnapshot> {
  const upstream = options.fetch ?? fetch;
  const previous = options.previous ?? {};
  const sources = (options.sources ?? PUBLIC_SOURCES).filter((s) =>
    publicDisplay(s.rights),
  );
  const token = () => randomBytes(32).toString("base64url");
  const { db, binding } = memoryD1();
  const env = {
    DB: binding,
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    EUROPE_WATCH_OWNER_TOKEN: token(),
    EUROPE_WATCH_COLLECTOR_TOKEN: token(),
    EUROPE_WATCH_WORKER_TOKEN: token(),
  } as unknown as Env;
  const call = async (
    route: string,
    token: string,
    payload?: unknown,
  ): Promise<any> => {
    const response = await server.fetch(
      new Request(ORIGIN + route, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
      env,
    );
    if (!response.ok)
      throw Error(`public_snapshot_api_${response.status}: ${route}`);
    return response.json();
  };
  try {
    const results = await collectSources(
      {
        EW_API_URL: ORIGIN,
        EW_COLLECTOR_TOKEN: env.EUROPE_WATCH_COLLECTOR_TOKEN,
      },
      {
        sources,
        fetch: upstream,
        resolveHost: options.resolveHost,
        maxRequests: RUN_OPERATIONS,
        request: (route, payload) =>
          call(route, env.EUROPE_WATCH_COLLECTOR_TOKEN, payload),
      },
    );
    // A run that reached no source would publish an empty map over the last good one.
    if (!results.some((r) => r.status === "ok"))
      throw Error("public_snapshot_sources_unavailable");
    // Batch triage hook. Narrative sources need model analysis before they can
    // publish. A triage step belongs here: claim jobs through
    // /api/worker/claim and submit results through /api/worker/complete with
    // env.EUROPE_WATCH_WORKER_TOKEN, using the OpenAI-compatible backend in
    // src/worker with provider keys held as deployment secrets. Completion
    // runs the host's result validation, evidence, place and severity checks,
    // so only accepted claims reach the snapshot read below. The structured
    // sources above queue no model work (their rights set ai to false).
    const snapshot = await call(
      "/api/snapshot?include_incoming=0",
      env.EUROPE_WATCH_OWNER_TOKEN,
    );
    const generated_at = new Date().toISOString();
    const ok = new Set(
      results.filter((r) => r.status === "ok").map((r) => r.source_id),
    );
    const lastSuccess = (id: string) =>
      ok.has(id)
        ? generated_at
        : (previous.manifest?.sources.find((s) => s.id === id)
            ?.last_success_at ?? null);
    // Like a stopped collector on the live app, a failed read leaves the source's last records up, here for a bounded time.
    const carried = (id: string) => {
      const at = lastSuccess(id);
      return (
        !ok.has(id) &&
        sources.some((s) => s.id === id) &&
        !!at &&
        Date.parse(generated_at) - Date.parse(at) < CARRY_FORWARD_SECONDS * 1000
      );
    };
    const kept = (previous.incidents?.incidents ?? []).filter(
      (i) =>
        i.reports.length > 0 &&
        i.reports.every((r) => carried(r.source_id)) &&
        !snapshot.incidents.some((x: IncidentView) => x.id === i.id),
    );
    const views: IncidentView[] = [...snapshot.incidents, ...kept];
    const briefs = Object.fromEntries(
      BRIEF_WINDOWS.map((hours) => [
        hours,
        structuredBrief(
          views.filter((i) => incidentInWindow(i, Number(hours))),
          Number(hours),
        ),
      ]),
    ) as PublicBriefs;
    const catalog =
      previous.geospatial && reusableGeospatial(previous.geospatial)
        ? previous.geospatial
        : await getGeospatialCatalog(WORLD, upstream);
    const geospatial: GeospatialCatalog = {
      ...catalog,
      sources: catalog.sources.map((s) => ({
        ...s,
        cadence_seconds: GEOSPATIAL_REFRESH_SECONDS,
      })),
    };
    // Each run starts from an empty database, so a revision is new when the previous snapshot didn't hold it.
    const seen = new Set(
      (previous.incidents?.incidents ?? []).flatMap((i) =>
        i.reports.map((r) => r.report_id + ":" + r.content_revision),
      ),
    );
    const lag = new Map<string, LagSample[]>();
    for (const i of snapshot.incidents as IncidentView[])
      for (const r of i.reports)
        if (!seen.has(r.report_id + ":" + r.content_revision))
          lag.set(r.source_id, [
            ...(lag.get(r.source_id) ?? []),
            ...issuerLag(
              [r],
              previous.manifest?.sources.find((s) => s.id === r.source_id)
                ?.last_success_at,
              Date.parse(i.ingested_at),
            ),
          ]);
    const now = Date.parse(generated_at);
    const incidents: PublicIncidents = {
      incidents: views,
      sources: snapshot.sources.map((s: any) => ({
        ...s,
        health: {
          ...s.health,
          last_success_at: lastSuccess(s.id),
          checkpoint: {
            ...s.health.checkpoint,
            issuer_lag: keepLag(
              [
                ...(previous.incidents?.sources.find((p) => p.id === s.id)
                  ?.health?.checkpoint?.issuer_lag ?? []),
                ...(lag.get(s.id) ?? []),
              ],
              now,
            ),
          },
        },
      })),
      limited: snapshot.limited,
    };
    const published = publicationLag(views, now);
    const files = new Map<string, string>();
    const contents: Record<PublicFile, unknown> = {
      "incidents.json": incidents,
      "brief.json": briefs,
      "geospatial.json": geospatial,
    };
    const sizes = {} as PublicManifest["files"];
    for (const [name, value] of Object.entries(contents) as [
      PublicFile,
      unknown,
    ][]) {
      const text = bounded(name, JSON.stringify(value));
      files.set(name, text);
      sizes[name] = {
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      };
    }
    const manifest: PublicManifest = {
      version: 1,
      generated_at,
      analysis: "none",
      files: sizes,
      sources: sources.map((s) => {
        const result = results.find((r) => r.source_id === s.id);
        const health = incidents.sources.find((x) => x.id === s.id)?.health;
        return {
          id: s.id,
          name: s.name,
          url: s.docs ?? s.url,
          status: result?.status ?? "skipped",
          received: result?.received ?? 0,
          ...(result?.error ? { error: result.error } : {}),
          last_success_at: lastSuccess(s.id),
          carried_forward: kept.filter((i) =>
            i.reports.some((r) => r.source_id === s.id),
          ).length,
          attribution: s.rights.attribution,
          redistribute: s.rights.redistribute,
          coverage: sourceCoverage(s, health, now, SNAPSHOT_CADENCE_SECONDS)
            .status,
          latency: sourceLatency(health, published.get(s.id), now),
        };
      }),
      layers: geospatial.sources.map(({ sensors, ...layer }) => ({
        ...layer,
        coverage: layerCoverage(layer, layer, now),
        ...(sensors
          ? {
              sensors: sensors.map((sensor) => ({
                id: sensor.id,
                coverage: layerCoverage(sensor, layer, now),
              })),
            }
          : {}),
      })),
    };
    files.set(MANIFEST, bounded(MANIFEST, JSON.stringify(manifest)));
    return { manifest, files, results };
  } finally {
    db.close();
  }
}

function bounded(name: keyof typeof PUBLIC_FILE_LIMITS, text: string) {
  const bytes = Buffer.byteLength(text);
  if (bytes > PUBLIC_FILE_LIMITS[name])
    throw Error(
      `public_snapshot_size: ${name} ${bytes} > ${PUBLIC_FILE_LIMITS[name]}`,
    );
  return text;
}
