import {claimBrief,renewBrief,completeBrief,failBrief,currentBrief,pruneBrief} from "./brief";
import { structuredBrief } from "./structured-brief";
import { ingestNews, newsCatalog, type NewsContext } from "./news";
import { sourceEligibility } from "../collector/index";
import { stableBundlePayload } from "./bundling";
import { FUSION_RULE, fusionCandidates, relink, sameEvent, withLinks } from "./fusion";
import { incidentInWindow, temporalStatus } from "../shared/temporal";
import {
  CONTRACT_VERSION,
  validateResult,
  validEventTime,
  Impact,
  Activity,
  type ObservationInput,
  type JobInput,
  type Lease,
  type IncidentView,
  type SourceRecord,
  type ModelRun,
} from "../shared/contracts";
import {
  resolveClaimLocation,
  bboxCandidates,
  eventTime,
  locationCell,
  locationRadius,
  windowKey,
} from "./geo";
import { textMatch, viewFilter } from "../shared/view";
import {
  alertDecision,
  alertMaterialityProjection,
  alertMaterialityVersion,
  situationDecision,
  SAME_SITUATION,
  type AlertRule,
  type AlertDeliverySnapshot,
} from "./alerts";
type Stmt = {
  bind(...v: any[]): Stmt;
  first<T = any>(column?: string): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<any>;
};
type DB = { prepare(sql: string): Stmt; batch(s: Stmt[]): Promise<any[]> };
export type Env = {
  DB: DB;
  STORAGE_PAUSED?: string;
  MAX_PENDING_JOBS?: string;
  MIGRATION_IMPORT?: string;
  _metrics?: {
    read: number;
    written: number;
    queries: number;
    unknown: number;
  };
  ASSETS: { fetch(r: Request): Promise<Response> };
  EUROPE_WATCH_OWNER_TOKEN: string;
  EUROPE_WATCH_WORKER_TOKEN: string;
  EUROPE_WATCH_COLLECTOR_TOKEN: string;
  PUBLIC_ORIGIN?: string;
  ANALYSIS_MODE?: string;
  /** Comma-separated provider/model pairs whose chat-completions results the owner accepts. */
  ACCEPTED_ANALYSIS_MODELS?: string;
};
/** Luna through Codex, or a chat-completions provider/model the owner listed explicitly. */
export function acceptedModelRun(
  run: any,
  e: Pick<Env, "ACCEPTED_ANALYSIS_MODELS">,
) {
  if (!run || (run.tool_attempts ?? 1) !== 0) return false;
  if (run.provider === undefined) return run.requested_model === "gpt-6-luna";
  return (e.ACCEPTED_ANALYSIS_MODELS ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .includes(run.provider + "/" + run.requested_model);
}
let quotaPausedUntil = 0;
const readMemo = new WeakMap<
  object,
  Map<string, { until: number; promise: Promise<any> }>
>();
async function memoRead<T>(
  e: Env,
  key: string,
  ttl: number,
  read: () => Promise<T>,
): Promise<T> {
  let cache = readMemo.get(e.DB);
  if (!cache) {
    cache = new Map();
    readMemo.set(e.DB, cache);
  }
  const prior = cache.get(key);
  if (prior && prior.until > Date.now()) return prior.promise;
  for (const [k, v] of cache) if (v.until <= Date.now()) cache.delete(k);
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  const promise = read();
  cache.set(key, { until: Date.now() + ttl, promise });
  try {
    return await promise;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}
const now = () => new Date().toISOString(),
  json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }),
  parse = (s: string) => JSON.parse(s);
const hash = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const eq = async (a: string, b: string) =>
  !!a && !!b && (await hash(a)) === (await hash(b));
function account(e: Env, result: any) {
  if (!e._metrics) return;
  const m = result?.meta;
  e._metrics.queries++;
  if (typeof m?.rows_read === "number" && typeof m?.rows_written === "number") {
    e._metrics.read += m.rows_read;
    e._metrics.written += m.rows_written;
  } else e._metrics.unknown++;
}
async function measuredBatch(e: Env, statements: Stmt[]) {
  const results = await e.DB.batch(statements);
  for (const result of results) account(e, result);
  return results;
}
function stmt(e: Env, sql: string, ...values: any[]) {
  const prepared = e.DB.prepare(sql).bind(...values);
  const all = prepared.all.bind(prepared),
    run = prepared.run.bind(prepared);
  prepared.all = async () => {
    const result = await all();
    account(e, result);
    return result;
  };
  prepared.first = async (column?: string) => {
    const result = await prepared.all();
    const row = result.results[0];
    return row ? (column ? row[column] : row) : null;
  };
  prepared.run = async () => {
    const result = await run();
    account(e, result);
    return result;
  };
  return prepared;
}
async function rows<T = any>(e: Env, sql: string, ...values: any[]) {
  return (await stmt(e, sql, ...values).all<T>()).results;
}
const newsContext = (e: Env): NewsContext => ({
  stmt: (sql, ...values) => stmt(e, sql, ...values),
  batch: (statements) => measuredBatch(e, statements as Stmt[]),
});
async function cookie(e: Env) {
  return hash(`europe-watch-session:${e.EUROPE_WATCH_OWNER_TOKEN}`);
}
async function role(r: Request, e: Env) {
  const token = r.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (await eq(token, e.EUROPE_WATCH_OWNER_TOKEN)) return "owner";
  if (await eq(token, e.EUROPE_WATCH_WORKER_TOKEN)) return "worker";
  if (await eq(token, e.EUROPE_WATCH_COLLECTOR_TOKEN)) return "collector";
  const c = r.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("ew_session="))
    ?.slice(11);
  return c && (await eq(c, await cookie(e))) ? "owner" : null;
}
const canonical = (url: string) => {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("invalid_source_url");
  u.hash = "";
  return u.href;
};
async function currentRights(e: Env, ids?: string[]) {
  return new Map(
    (
      await rows(
        e,
        ids?.length
          ? `SELECT id,record FROM sources WHERE id IN(${ids.map(() => "?").join(",")})`
          : "SELECT id,record FROM sources",
        ...(ids ?? []),
      )
    ).map((v) => [v.id, (parse(v.record) as SourceRecord).rights]),
  );
}
function permittedView(
  i: IncidentView,
  rights: Map<string, SourceRecord["rights"]>,
) {
  return (
    Array.isArray(i.reports) &&
    i.reports.length > 0 &&
    i.reports.every((r: any) => {
      const p = rights.get(r.source_id);
      return p?.access && p.storage && p.display;
    })
  );
}
function refreshRights(
  i: IncidentView,
  rights: Map<string, SourceRecord["rights"]>,
): IncidentView {
  return {
    ...i,
    reports: i.reports.map((r: any) => ({
      ...r,
      rights: rights.get(r.source_id),
    })),
  };
}
// A material comparison must use the last notice eligible for this rule, not
// an intervening revision whose delivery was suppressed. UI eligibility is not
// evidence of delivery through an external notification channel. `covered`
// reads instead the last notice withheld because a same-event partner gave it.
async function lastAlertDelivery(
  e: Env,
  incidentId: string,
  ruleId: string,
  rule: AlertRule,
  covered = false,
): Promise<AlertDeliverySnapshot | null> {
  const last = await stmt(
    e,
    `SELECT d.created_at,d.state,d.incident_version,d.rule_version,
      coalesce(v.view,i.view) AS delivered_view
     FROM alert_deliveries d
     LEFT JOIN incident_revisions v ON v.incident_id=d.incident_id AND v.version=d.incident_version
     LEFT JOIN incidents i ON i.id=d.incident_id AND i.version=d.incident_version AND i.deleted_at IS NULL
     WHERE d.incident_id=? AND d.rule_id=? AND ${covered ? `d.state='suppressed' AND d.reason LIKE '${SAME_SITUATION}%'` : "d.state='eligible_ui'"}
     ORDER BY d.incident_version DESC,d.rule_version DESC LIMIT 1`,
    incidentId,
    ruleId,
  ).first<{
    created_at: string;
    state: string;
    incident_version: number;
    rule_version: number;
    delivered_view: string | null;
  }>();
  if (!last) return null;
  let delivered: IncidentView | null = null;
  if (last.delivered_view) {
    try {
      const candidate = parse(last.delivered_view) as IncidentView;
      if (candidate.id === incidentId && candidate.version === last.incident_version)
        delivered = candidate;
    } catch {
      // Purged/unreadable history is unknown, never a made-up delivered state.
    }
  }
  return {
    state: last.state,
    created_at: last.created_at,
    material_projection: delivered ? alertMaterialityProjection(delivered, rule) : null,
    material_version: delivered ? alertMaterialityVersion(delivered, rule) : null,
  };
}

async function correctionAlerts(
  e: Env,
  view: IncidentView,
  acceptance?: { sql: string; values: unknown[] },
): Promise<Stmt[]> {
  const result: Stmt[] = [];
  const partners = (view.links ?? [])
    .filter((l) => l.type === "same_event")
    .map((l) => l.incident_id);
  for (const rule of await rows(
    e,
    "SELECT r.*,a.geometry FROM alert_rules r LEFT JOIN watch_areas a ON a.id=json_extract(r.rule,'$.watch_area_id') WHERE r.owner_id='owner'",
  )) {
    const policy = parse(rule.rule) as AlertRule;
    const last = await lastAlertDelivery(e, view.id, rule.id, policy);
    let decision = alertDecision(
      view,
      policy,
      rule.geometry ? parse(rule.geometry) : null,
      last,
    );
    // Only a first notice of a linked record can repeat its situation, so only then read the partners' notices.
    if (decision.state === "eligible_ui" && !last && partners.length) {
      let partner: (AlertDeliverySnapshot & { incident_id: string }) | null = null;
      for (const id of partners) {
        const notice = await lastAlertDelivery(e, id, rule.id, policy);
        if (notice && (!partner || notice.created_at! > partner.created_at!))
          partner = { ...notice, incident_id: id };
      }
      if (partner)
        decision = situationDecision(
          decision,
          view,
          last,
          partner,
          await lastAlertDelivery(e, view.id, rule.id, policy, true),
        );
    }
    result.push(
      stmt(
        e,
        `INSERT OR IGNORE INTO alert_deliveries(id,incident_id,incident_version,rule_id,rule_version,state,reason,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${acceptance?.sql ?? "1"}`,
        await hash(`${view.id}:${view.version}:${rule.id}:${rule.version}`),
        view.id,
        view.version,
        rule.id,
        rule.version,
        decision.state,
        decision.reason,
        now(),
        ...(acceptance?.values ?? []),
      ),
    );
  }
  return result;
}
export async function enforceRetention(e: Env) {
  await pruneBrief({stmt:(sql,...values)=>stmt(e,sql,...values)});
  const expired = await rows(
    e,
    "SELECT id FROM observations INDEXED BY observations_expiry WHERE deleted_at IS NULL AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY expires_at LIMIT 20",
  );
  if (!expired.length) return { expired: 0 };
  const ids = expired.map((x) => x.id),
    marks = ids.map(() => "?").join(",");
  const affected = `SELECT DISTINCT incident_id FROM evidence_links WHERE report_id IN(${marks})`;
  const time = now();
  await measuredBatch(e, [
    stmt(e, `DELETE FROM outbox WHERE entity_id IN(${affected})`, ...ids),
    stmt(e, `DELETE FROM claims WHERE incident_id IN(${affected})`, ...ids),
    stmt(
      e,
      `DELETE FROM incident_revisions WHERE incident_id IN(${affected})`,
      ...ids,
    ),
    stmt(
      e,
      `UPDATE incidents SET view='{}',deleted_at=? WHERE id IN(${affected})`,
      time,
      ...ids,
    ),
    stmt(
      e,
      `DELETE FROM evidence_links WHERE incident_id IN(${affected})`,
      ...ids,
    ),
    stmt(e, `DELETE FROM outbox WHERE entity_id IN(${marks})`, ...ids),
    stmt(
      e,
      `DELETE FROM analysis_results WHERE report_id IN(${marks})`,
      ...ids,
    ),
    stmt(
      e,
      `UPDATE analysis_jobs SET state='excluded',error_kind='retention_expired',error=NULL,lease_until=NULL WHERE report_id IN(${marks})`,
      ...ids,
    ),
    stmt(
      e,
      `DELETE FROM observation_revisions WHERE report_id IN(${marks})`,
      ...ids,
    ),
    stmt(
      e,
      `UPDATE observations SET canonical_url='',deleted_at=? WHERE id IN(${marks})`,
      time,
      ...ids,
    ),
    stmt(
      e,
      "DELETE FROM origin_groups WHERE id NOT IN(SELECT origin_id FROM evidence_links)",
    ),
    stmt(
      e,
      "INSERT INTO outbox(event_type,entity_id,payload) VALUES('resync','retention','{\"reason\":\"retention_expired\"}')",
    ),
  ]);
  readMemo.delete(e.DB);
  statusCaches.delete(e.DB);
  return { expired: ids.length };
}
export async function ingest(e: Env, items: ObservationInput[]) {
  if (!Array.isArray(items) || items.length > 3) throw Error("invalid_batch");
  const accepted: any[] = [];
  for (let item of items) {
    const source = await stmt(
      e,
      "SELECT record FROM sources WHERE id=?",
      item.source_id,
    ).first<{ record: string }>();
    if (!source) throw Error("unknown_source");
    const s = parse(source.record) as SourceRecord;
    if (!s.rights.access || !s.rights.storage)
      throw Error("source_storage_not_permitted");
    if (
      typeof item.native_id !== "string" ||
      !item.native_id ||
      typeof item.title !== "string" ||
      item.title.length > 2000 ||
      !Array.isArray(item.excerpts) ||
      item.excerpts.some(
        (v) =>
          typeof v.id !== "string" ||
          typeof v.text !== "string" ||
          v.text.length > 20000,
      )
    )
      throw Error("invalid_observation");
    canonical(item.canonical_url);
    if (item.source_event_id && (typeof item.source_event_id !== "string" || item.source_event_id.length > 250)) throw Error("invalid_source_event_id");
    if (item.source_reports && (!Array.isArray(item.source_reports) || item.source_reports.length > 32 || item.source_reports.some(v => typeof v.native_id !== "string" || v.native_id.length > 250 || typeof v.canonical_url !== "string"))) throw Error("invalid_source_reports");
    for (const report of item.source_reports ?? []) canonical(report.canonical_url);
    if (
      item.source_geo &&
      (!Number.isFinite(item.source_geo.lon) ||
        !Number.isFinite(item.source_geo.lat) ||
        Math.abs(item.source_geo.lon) > 180 ||
        Math.abs(item.source_geo.lat) > 90 ||
        (item.source_geo.country != null &&
          !/^[A-Z]{2}$/.test(item.source_geo.country)))
    )
      throw Error("invalid_geography");
    if (
      (item.official?.activity !== undefined &&
        !Activity.safeParse(item.official.activity).success) ||
      (item.official?.impact !== undefined &&
        !Impact.safeParse(item.official.impact).success)
    )
      throw Error("invalid_official_classification");
    const id = await hash(`${item.source_id}:${item.native_id}`);
    let rev = await hash(
      JSON.stringify({
        title: item.title,
        excerpts: item.excerpts,
        geo: item.source_geo,
        official: item.official,
        published: item.published_at,
      }),
    );
    const existing = await stmt(
      e,
      "SELECT * FROM observations WHERE id=?",
      id,
    ).first<any>();
    if (existing && !existing.deleted_at) {
      const previous = await stmt(
        e,
        "SELECT input FROM observation_revisions WHERE report_id=? AND revision=?",
        id,
        existing.latest_revision,
      ).first<any>();
      if (previous) {
        const old = parse(previous.input);
        // A rolling upstream feed must not erase earlier messages in the same explicit police episode.
        if (item.source_id === "no-politiloggen" && item.source_event_id && old.source_event_id === item.source_event_id && item.source_reports?.length && old.source_reports?.length) {
          const reports = [...new Map([...old.source_reports, ...item.source_reports].map((v: any) => [v.native_id, v])).values()] as NonNullable<ObservationInput["source_reports"]>;
          const retained = reports.filter(v => !v.published_at || Date.parse(v.published_at) >= Date.now()-30*86400000).sort((a,b) => (a.published_at ?? "").localeCompare(b.published_at ?? "") || a.native_id.localeCompare(b.native_id)).slice(-32);
          const excerpts = [...new Map([...old.excerpts, ...item.excerpts].map((v: any) => [v.id, v])).values()] as ObservationInput["excerpts"];
          item = { ...item, source_reports: retained, excerpts: excerpts.filter(v => retained.some(r => v.id.startsWith(r.native_id + ":"))).sort((a,b) => retained.findIndex(r => a.id.startsWith(r.native_id + ":")) - retained.findIndex(r => b.id.startsWith(r.native_id + ":")) || a.id.localeCompare(b.id)), published_at: old.published_at ?? item.published_at, source_updated_at: [old.source_updated_at, item.source_updated_at].filter(Boolean).sort().at(-1) ?? null, title: old.title };
          rev = await hash(JSON.stringify({title:item.title,excerpts:item.excerpts,geo:item.source_geo,official:item.official,published:item.published_at}));
        }
        const normalized = (o: ObservationInput) =>
          JSON.stringify({
            title: o.title,
            excerpts: o.excerpts,
            geo: o.source_geo,
            official: o.official,
            published: o.published_at,
          });
        if (normalized(old) === normalized(item))
          rev = existing.latest_revision;
      }
    }
    if (existing?.deleted_at) {
      accepted.push({ report_id: id, deleted: true });
      continue;
    }
    if (item.eligibility && (typeof item.eligibility.eligible !== "boolean" ||
      typeof item.eligibility.reason !== "string" || !item.eligibility.reason.trim() || item.eligibility.reason.length > 200 ||
      typeof item.eligibility.policy_version !== "string" || item.eligibility.policy_version.length > 80))
      throw Error("invalid_eligibility");
    const excluded = item.eligibility?.eligible === false;
    if (!excluded && s.rights.ai && existing?.latest_revision !== rev) {
      const load = await stmt(e, "SELECT coalesce(sum(count),0) AS n FROM queue_counters WHERE state IN('pending','retrying','analyzing')").first<any>();
      const cap = Math.max(100, Math.min(100000, Number(e.MAX_PENDING_JOBS) || 10000));
      if (Number(load?.n ?? 0) >= cap) throw Error("queue_capacity_retry");
    }
    const time = now();
    const input: JobInput = {
      ...item,
      report_id: id,
      content_revision: rev,
      contract_version: CONTRACT_VERSION,
      first_observed_at: existing?.first_observed_at ?? time,
      ingested_at: time,
    };
    const job = await hash(`${id}:${rev}:${CONTRACT_VERSION}`),
      state = excluded ? "excluded" : s.rights.ai ? "pending" : "blocked";
    const bundlePayload = !excluded && s.rights.ai ? stableBundlePayload(item, s) : null;
    const bundleKey = bundlePayload ? await hash(CONTRACT_VERSION + ":" + bundlePayload) : null;
    const statements = [
      stmt(
        e,
        "INSERT INTO observations(id,source_id,native_id,canonical_url,first_observed_at,latest_revision) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET latest_revision=excluded.latest_revision,canonical_url=excluded.canonical_url",
        id,
        item.source_id,
        item.native_id,
        item.canonical_url,
        input.first_observed_at,
        rev,
      ),
      stmt(
        e,
        "INSERT OR IGNORE INTO observation_revisions(report_id,revision,input,ingested_at) VALUES(?,?,?,?)",
        id,
        rev,
        JSON.stringify(input),
        time,
      ),
      stmt(
        e,
        "INSERT OR IGNORE INTO analysis_jobs(id,report_id,revision,contract_version,state,priority,available_at,created_at,error_kind) VALUES(?,?,?,?,?,?,?,?,?)",
        job,
        id,
        rev,
        CONTRACT_VERSION,
        state,
        item.priority ?? 0,
        time,
        time,
        excluded ? `eligibility:${item.eligibility!.policy_version}:${item.eligibility!.reason}` : s.rights.ai ? null : "rights",
      ),
    ];
    if (bundleKey) statements.push(
      stmt(e, "INSERT OR IGNORE INTO analysis_bundles(bundle_key,leader_job_id,created_at) VALUES(?,?,?)", bundleKey, job, time),
      stmt(e, "INSERT OR IGNORE INTO bundle_members(job_id,bundle_key) VALUES(?,?)", job, bundleKey),
      stmt(e, "UPDATE analysis_jobs SET state='bundled',error_kind='shared_exact_content' WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM analysis_bundles b JOIN analysis_jobs l ON l.id=b.leader_job_id WHERE b.bundle_key=? AND b.leader_job_id<>analysis_jobs.id AND l.state NOT IN('excluded','permanently_failed','blocked'))", job, bundleKey),
    );
    if (existing?.latest_revision !== rev)
      statements.push(
        stmt(
          e,
          "INSERT INTO outbox(event_type,entity_id,payload) VALUES(?,?,?)",
          "incoming",
          id,
          JSON.stringify({
            report_id: id,
            content_revision: rev,
            catchup: true,
          }),
        ),
      );
    if (
      item.official &&
      (item.source_geo ||
        ((item.official.references?.length ?? 0) > 0 && s.family === "bbk")) &&
      s.rights.display &&
      existing?.latest_revision !== rev
    ) {
      const refs =
        s.family === "bbk" ? (item.official.references ?? []).slice(0, 20) : [];
      const ancestors = refs.length
        ? await rows(
            e,
            `SELECT DISTINCT i.id FROM observations o JOIN evidence_links l ON l.report_id=o.id JOIN incidents i ON i.id=l.incident_id WHERE o.source_id=? AND o.native_id IN(${refs.map(() => "?").join(",")}) AND i.deleted_at IS NULL`,
            item.source_id,
            ...refs,
          )
        : [];
      const iid = ancestors[0]?.id ?? (await hash(item.source_event_id ? `${item.source_id}:${item.source_event_id}:0` : `${id}:0`));
      const previous = await stmt(
          e,
          "SELECT version,view FROM incidents WHERE id=?",
          iid,
        ).first<any>(),
        version = (previous?.version ?? 0) + 1,
        g = item.source_geo;
      let view: IncidentView = {
        id: iid,
        version,
        headline: item.title,
        summary_en: item.excerpts.map((v) => v.text).join(" "),
        summary_it: null,
        activity: item.official.activity ?? "official_advisory",
        impact: item.official.impact ?? "unknown",
        evidence_status: item.official.self_reported
          ? "unverified"
          : "official_advisory",
        location: g
          ? {
              ...g,
              country:
                g.country ??
                (s.countries.length === 1 && s.countries[0] !== "*"
                  ? s.countries[0]
                  : null),
              radius_km: g.radius_km ?? (g.accuracy === "area" ? 20 : 8),
            }
          : item.official.cancelled && previous?.view
            ? parse(previous.view).location
            : null,
        event_start: item.official.effective_at,
        event_end: null,
        published_at: item.published_at,
        ingested_at: time,
        analyzed_at: null,
        updated_at: time,
        expires_at: item.official.expires_at,
        claims: [],
        reports: [
          {
            report_id: id,
            source_id: s.id,
            source_name: s.name,
            canonical_url: item.canonical_url,
            title: item.title,
            excerpts: item.excerpts,
            input_coverage: item.input_coverage,
            published_at: item.published_at,
            original_language: item.original_language,
            content_revision: rev,
            rights: s.rights,
          },
        ],
        history: [],
        review_needed: false,
        cancelled: item.official.cancelled ?? false,
        ...(item.official.current_listing === true
          ? { current_listing: true }
          : {}),
      };
      const candidates = fusionCandidates(view),
        prior =
          (previous?.view ? (parse(previous.view) as IncidentView).links : null) ?? [];
      const others = [
        ...(candidates ? await rows(e, candidates.sql, ...candidates.params) : []),
        ...(prior.length
          ? await rows(
              e,
              `SELECT view FROM incidents WHERE deleted_at IS NULL AND id IN(${prior.map(() => "?").join(",")})`,
              ...prior.map((l) => l.incident_id),
            )
          : []),
      ].map((v) => parse(v.view) as IncidentView);
      const fused = relink(
        view,
        prior,
        [...new Map(others.map((v) => [v.id, v])).values()],
      );
      view = withLinks(view, fused.links);
      for (const other of fused.changed) {
        const revised = { ...other, version: other.version + 1, updated_at: time };
        statements.push(
          stmt(
            e,
            "UPDATE incidents SET view=?,version=?,updated_at=? WHERE id=?",
            JSON.stringify(revised),
            revised.version,
            time,
            revised.id,
          ),
          stmt(
            e,
            "INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)",
            revised.id,
            revised.version,
            JSON.stringify(revised),
            time,
            `same-event links revised by ${FUSION_RULE} after incident ${iid} changed`,
          ),
          stmt(
            e,
            "INSERT INTO outbox(event_type,entity_id,payload) VALUES('incident.updated',?,?)",
            revised.id,
            JSON.stringify({ incident: revised, catchup: true }),
          ),
        );
      }
      statements.push(
        stmt(
          e,
          "INSERT INTO incidents(id,version,view,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,view=excluded.view,updated_at=excluded.updated_at",
          iid,
          version,
          JSON.stringify(view),
          time,
        ),
        stmt(
          e,
          "INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)",
          iid,
          version,
          JSON.stringify(view),
          time,
          item.official.message_type === "Cancel"
            ? "issuer CAP cancellation of referenced warning"
            : refs.length
              ? "issuer CAP update of referenced warning"
              : "issuer structured fields; AI pending",
        ),
        stmt(
          e,
          "INSERT INTO outbox(event_type,entity_id,payload) VALUES(?,?,?)",
          previous ? "incident.updated" : "incident.created",
          iid,
          JSON.stringify({ incident: view, catchup: true }),
        ),
      );
      for (const ancestor of ancestors.slice(1)) {
        const saved = await stmt(
          e,
          "SELECT view,version FROM incidents WHERE id=?",
          ancestor.id,
        ).first<any>();
        if (saved) {
          const prior = parse(saved.view) as IncidentView;
          const revised = {
            ...prior,
            version: saved.version + 1,
            cancelled: true,
            evidence_status: "corrected",
            summary_en:
              "Superseded by an explicit issuer CAP update or cancellation.",
            updated_at: time,
          };
          statements.push(
            stmt(
              e,
              "UPDATE incidents SET view=?,version=?,updated_at=? WHERE id=?",
              JSON.stringify(revised),
              revised.version,
              time,
              revised.id,
            ),
            stmt(
              e,
              "INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)",
              revised.id,
              revised.version,
              JSON.stringify(revised),
              time,
              "explicit issuer CAP reference",
            ),
            stmt(
              e,
              "INSERT INTO outbox(event_type,entity_id,payload) VALUES('incident.updated',?,?)",
              revised.id,
              JSON.stringify({ incident: revised, catchup: true }),
            ),
          );
        }
      }
      // Every published revision meets the watch rules, including the first.
      statements.push(...(await correctionAlerts(e, view)));
      const origin = await hash(item.canonical_url);
      statements.push(
        stmt(
          e,
          "INSERT OR IGNORE INTO origin_groups(id,canonical_url) VALUES(?,?)",
          origin,
          item.canonical_url,
        ),
        stmt(
          e,
          "INSERT OR IGNORE INTO evidence_links(incident_id,report_id,revision,origin_id) VALUES(?,?,?,?)",
          iid,
          id,
          rev,
          origin,
        ),
      );
    }
    statements.push(stmt(e, "UPDATE observations SET expires_at=(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',ingested_at,?) FROM observation_revisions WHERE report_id=? AND revision=?) WHERE id=?", `+${Math.max(0,s.rights.retention_days)} days`,id,rev,id));
    await measuredBatch(e, statements);
    if (bundleKey) await settleBundles(e, bundleKey, 3);
    accepted.push({
      report_id: id,
      content_revision: rev,
      job_id: job,
      unchanged: existing?.latest_revision === rev,
      state: bundleKey ? (await stmt(e, "SELECT state FROM analysis_jobs WHERE id=?", job).first<any>())?.state ?? state : state,
    });
  }
  return { accepted };
}
const statusCaches = new WeakMap<
  object,
  { until: number; promise: Promise<any> }
>();
async function status(e: Env) {
  const cached = statusCaches.get(e.DB);
  if (cached && cached.until > Date.now()) return cached.promise;
  const promise = computeStatus(e);
  statusCaches.set(e.DB, { until: Date.now() + 60000, promise });
  try {
    return await promise;
  } catch (error) {
    statusCaches.delete(e.DB);
    throw error;
  }
}
async function computeStatus(e: Env) {
  const counts = await rows(
    e,
    "SELECT state,count,oldest FROM queue_counters WHERE count>0",
  );
  const workers = await rows(
    e,
    "SELECT * FROM workers ORDER BY last_seen DESC LIMIT 5",
  );
  const health = await rows(e, "SELECT * FROM source_health");
  const total = counts
    .filter((v) =>
      ["pending", "retrying", "analyzing"].includes(v.state),
    )
    .reduce((n, v) => n + v.count, 0);
  const eligibleStates = counts.filter(
    (v) => !["excluded", "blocked"].includes(v.state),
  );
  const samples = {
    n: eligibleStates.reduce((n, v) => n + v.count, 0),
    first: eligibleStates
      .map((v) => v.oldest)
      .filter(Boolean)
      .sort()[0],
  };
  const runs = await rows(
    e,
    "SELECT run FROM analysis_results ORDER BY analyzed_at DESC LIMIT 100",
  );
  const uniqueRuns = [
    ...new Map(
      runs.map((v) => {
        const run = parse(v.run);
        return [run.invocation_id ?? v.run, run];
      }),
    ).values(),
  ];
  const duration = uniqueRuns.reduce((n, v) => n + (v.duration_ms ?? 0), 0);
  const elapsed = samples.first
    ? (Date.now() - Date.parse(samples.first)) / 1000
    : 0;
  const lambda = elapsed >= 300 ? samples.n / elapsed : null,
    mu = duration > 0 ? runs.length / (duration / 1000) : null;
  const pendingRows = counts.filter((v) =>
    ["pending", "retrying", "analyzing"].includes(v.state),
  );
  const oldest = pendingRows.map((v) => v.oldest).sort()[0] ?? null;
  const estimate = {
    incoming_reports_per_second: lambda,
    completed_reports_per_inference_second: mu,
    observed_seconds: elapsed,
    analysis_sample_size: runs.length,
    awake_fraction: null,
    sustainable: null,
    catchup_seconds:
      lambda !== null && mu !== null && mu > lambda
        ? total / (mu - lambda)
        : null,
    method:
      "Observed eligible analysis identities (including substantive revisions and initial historical retrieval) since first acceptance; completed reports per sum of reported inference durations. Awake fraction unknown; catch-up assumes continuously available worker and excludes startup and quota pauses.",
    confidence:
      elapsed >= 3600 && runs.length >= 20
        ? "provisional"
        : "insufficient_sample",
  };
  return {
    mode: e.ANALYSIS_MODE ?? "local-codex",
    pending: total,
    oldest_pending_at: oldest,
    oldest_pending_seconds: oldest
      ? (Date.now() - Date.parse(oldest)) / 1000
      : null,
    states: counts,
    workers,
    source_health: health,
    source_freshness: health
      .filter((v) => v.last_success_at)
      .map((v) => ({
        source_id: v.source_id,
        last_success_at: v.last_success_at,
        error: v.error,
      })),
    ai_freshness: await stmt(
      e,
      "SELECT analyzed_at AS last_analyzed_at FROM analysis_results ORDER BY analyzed_at DESC LIMIT 1",
    ).first(),
    capacity_estimate: estimate,
    worker_state: workers[0]
      ? Date.now() - Date.parse(workers[0].last_seen) > 120000
        ? "offline"
        : workers[0].state
      : "not_seen",
    worker_last_seen: workers[0]?.last_seen ?? null,
    blocked_count: counts.find((v) => v.state === "blocked")?.count ?? 0,
    dead_letter_count:
      counts.find((v) => v.state === "permanently_failed")?.count ?? 0,
    subscription_capacity: "unknown",
    queue_durable: true,
  };
}
/** Worldwide sources balance by the country each observation states, never one shared "*" bucket. */
const FAIRNESS_COUNTRY =
  "coalesce(json_extract(r.input,'$.source_geo.country'),nullif(json_extract(s.record,'$.countries[0]'),'*'))";
async function claim(e: Env, worker: string, limit: number) {
  if (typeof worker !== "string" || worker.length > 150)
    throw Error("invalid_worker");
  await settleBundles(e);
  const time = now(),
    until = new Date(Date.now() + 120000).toISOString();
  await measuredBatch(e, [
    stmt(
      e,
      "UPDATE analysis_jobs SET state='retrying',lease_until=NULL,error_kind='lease_expired',available_at=? WHERE state='analyzing' AND lease_until<=?",
      time,
      time,
    ),
    stmt(
      e,
      "INSERT INTO workers(id,last_seen,state) VALUES(?,?,'online') ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,state='online'",
      worker,
      time,
    ),
  ]);
  const result: Lease[] = [];
  const held = await rows(
    e,
    `SELECT o.source_id,${FAIRNESS_COUNTRY} AS country FROM analysis_jobs j JOIN observations o ON o.id=j.report_id JOIN sources s ON s.id=o.source_id JOIN observation_revisions r ON r.report_id=j.report_id AND r.revision=j.revision WHERE j.state='analyzing' LIMIT 50`,
  );
  const countryLoad = new Map<string, number>();
  const sourceLoad = new Map<string, number>();
  for (const h of held) {
    countryLoad.set(h.country, (countryLoad.get(h.country) ?? 0) + 1);
    sourceLoad.set(h.source_id, (sourceLoad.get(h.source_id) ?? 0) + 1);
  }
  for (let n = 0; n < Math.min(Math.max(limit || 1, 1), 12); n++) {
    const attempt = crypto.randomUUID();
    const oldestSlot = n % 4 === 3;
    // Bounded indexed candidates; never run a correlated country scan for every pending job.
    const candidates = await rows(
      e,
      `SELECT j.id,j.priority,o.source_id,${FAIRNESS_COUNTRY} AS country FROM analysis_jobs j INDEXED BY ${oldestSlot ? "jobs_pending_fifo" : "jobs_pending_priority"} JOIN observations o ON o.id=j.report_id JOIN sources s ON s.id=o.source_id JOIN observation_revisions r ON r.report_id=j.report_id AND r.revision=j.revision WHERE j.state IN ('pending','retrying') AND j.available_at<=? AND o.deleted_at IS NULL AND json_extract(s.record,'$.rights.ai')=1 AND json_extract(s.record,'$.rights.storage')=1 AND json_extract(s.record,'$.rights.access')=1 AND json_extract(s.record,'$.status') IN('enabled','degraded') AND coalesce(json_extract(s.record,'$.config.context_only'),0)=0 ORDER BY ${oldestSlot ? "j.created_at" : "j.priority DESC,j.created_at"} LIMIT 32`,
      time,
    );
    if (!candidates.length) break;
    const candidate = oldestSlot
      ? candidates[0]
      : candidates.reduce((best, next) =>
          // Keep urgent work ahead, balance source and country inside each priority band.
          Math.floor(next.priority / 25) > Math.floor(best.priority / 25) ||
          (Math.floor(next.priority / 25) === Math.floor(best.priority / 25) &&
            ((countryLoad.get(next.country) ?? 0) * 2 + (sourceLoad.get(next.source_id) ?? 0)) <
            ((countryLoad.get(best.country) ?? 0) * 2 + (sourceLoad.get(best.source_id) ?? 0))) ? next : best,
        );
    const job = await stmt(
      e,
      "UPDATE analysis_jobs SET state='analyzing',worker_id=?,attempt_id=?,fence=fence+1,lease_until=?,attempts=attempts+1 WHERE id=? AND state IN ('pending','retrying') AND available_at<=? RETURNING *",
      worker,
      attempt,
      until,
      candidate.id,
      time,
    ).first<any>();
    if (job) {
      countryLoad.set(candidate.country, (countryLoad.get(candidate.country) ?? 0) + 1);
      sourceLoad.set(candidate.source_id, (sourceLoad.get(candidate.source_id) ?? 0) + 1);
    }
    if (!job) break;
    const input = await stmt(
      e,
      "SELECT input FROM observation_revisions WHERE report_id=? AND revision=?",
      job.report_id,
      job.revision,
    ).first<any>();
    result.push({
      job_id: job.id,
      attempt_id: attempt,
      fence: job.fence,
      lease_until: until,
      input: parse(input.input),
    });
  }
  return { leases: result };
}
async function settleBundles(e: Env, key?: string, limit = 12) {
  const waiting = await rows(e, "SELECT j.id,b.bundle_key,b.leader_job_id,l.state AS leader_state FROM analysis_jobs j INDEXED BY jobs_waiting_bundle JOIN bundle_members m ON m.job_id=j.id JOIN analysis_bundles b ON b.bundle_key=m.bundle_key JOIN analysis_jobs l ON l.id=b.leader_job_id WHERE j.state='bundled' AND j.completed_at IS NULL ORDER BY j.created_at LIMIT 12");
  const promoted = new Set<string>();
  for (const candidate of waiting) if (["excluded","permanently_failed"].includes(candidate.leader_state) && !promoted.has(candidate.bundle_key)) {
    promoted.add(candidate.bundle_key);
    await measuredBatch(e, [stmt(e, "UPDATE analysis_bundles SET leader_job_id=? WHERE bundle_key=? AND leader_job_id=?", candidate.id, candidate.bundle_key, candidate.leader_job_id), stmt(e, "UPDATE analysis_jobs SET state='pending',error_kind=NULL WHERE id=? AND state='bundled' AND completed_at IS NULL", candidate.id)]);
  }
  const members = await rows(e, `SELECT j.id,j.report_id,j.revision,r.input,b.leader_job_id FROM analysis_jobs j INDEXED BY jobs_waiting_bundle JOIN bundle_members m ON m.job_id=j.id JOIN analysis_bundles b ON b.bundle_key=m.bundle_key JOIN analysis_jobs leader ON leader.id=b.leader_job_id JOIN observation_revisions r ON r.report_id=j.report_id AND r.revision=j.revision JOIN observations o ON o.id=j.report_id JOIN sources s ON s.id=o.source_id WHERE j.state='bundled' AND j.completed_at IS NULL AND leader.state='analyzed' AND o.deleted_at IS NULL AND o.latest_revision=j.revision AND json_extract(s.record,'$.rights.ai')=1 AND json_extract(s.record,'$.rights.storage')=1 ${key ? "AND b.bundle_key=?" : ""} LIMIT ?`, ...(key ? [key] : []), limit);
  for (const member of members) {
    const input = parse(member.input) as JobInput;
    const incidentIds = await rows(e, "SELECT DISTINCT l.incident_id FROM evidence_links l JOIN analysis_jobs j ON j.report_id=l.report_id AND j.revision=l.revision JOIN incidents i ON i.id=l.incident_id WHERE j.id=? AND i.deleted_at IS NULL LIMIT 20", member.leader_job_id);
    const origin = await hash(input.canonical_url);
    const statements = [stmt(e, "INSERT OR IGNORE INTO origin_groups(id,canonical_url,independence) VALUES(?,?,'shared_content')", origin, input.canonical_url),
      ...incidentIds.map(i => stmt(e, "INSERT OR IGNORE INTO evidence_links(incident_id,report_id,revision,origin_id) VALUES(?,?,?,?)", i.incident_id, input.report_id, input.content_revision, origin)),
      stmt(e, "UPDATE analysis_jobs SET completed_at=?,error_kind='shared_exact_content' WHERE id=? AND state='bundled'", now(), member.id)];
    await measuredBatch(e, statements);
  }
  return members.length;
}
async function complete(
  e: Env,
  lease: Lease,
  result: unknown,
  run: ModelRun,
  conflicts = 0,
): Promise<Response> {
  const job = await stmt(
    e,
    "SELECT j.*,r.input FROM analysis_jobs j JOIN observation_revisions r ON r.report_id=j.report_id AND r.revision=j.revision WHERE j.id=?",
    lease.job_id,
  ).first<any>();
  if (!job) return json({ error: "job_not_found" }, 404);
  if (job.state === "analyzed") {
    const saved = await stmt(
      e,
      "SELECT result FROM analysis_results WHERE job_id=?",
      job.id,
    ).first<any>();
    return json({
      accepted:
        !!saved &&
        JSON.stringify(parse(saved.result)) === JSON.stringify(result),
      already_completed: true,
    });
  }
  if (
    job.state !== "analyzing" ||
    job.attempt_id !== lease.attempt_id ||
    job.fence !== lease.fence ||
    job.lease_until <= now()
  )
    return json({ accepted: false, error: "lease_lost" }, 409);
  const input = parse(job.input) as JobInput,
    r = validateResult(result, input);
  const permissionRow = await stmt(
    e,
    "SELECT record FROM sources WHERE id=?",
    input.source_id,
  ).first<any>();
  const permission = permissionRow ? parse(permissionRow.record).rights : null;
  if (!permission?.access || !permission.storage || !permission.ai) {
    await stmt(
      e,
      "UPDATE analysis_jobs SET state='blocked',error_kind='rights',lease_until=NULL WHERE id=? AND attempt_id=? AND fence=?",
      job.id,
      lease.attempt_id,
      lease.fence,
    ).run();
    return json(
      { accepted: false, error: "current_source_rights_forbid_analysis" },
      403,
    );
  }
  if (!acceptedModelRun(run, e)) throw Error("invalid_model_run");
  const time = now(),
    aid = await hash(`analysis:${job.id}`);
  const guard =
    "EXISTS(SELECT 1 FROM analysis_results a JOIN observations o ON o.id=a.report_id JOIN sources s ON s.id=o.source_id WHERE a.id=? AND o.latest_revision=a.revision AND o.deleted_at IS NULL AND json_extract(s.record,'$.rights.display')=1 AND json_extract(s.record,'$.rights.storage')=1)";
  const retained = new Set<string>();
  const candidates = (
    await rows(
      e,
      "SELECT id,view FROM incidents WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1000",
    )
  ).map((v) => ({ id: v.id, view: parse(v.view) as IncidentView }));
  const statements = [
    stmt(
      e,
      "INSERT OR IGNORE INTO analysis_results(id,job_id,report_id,revision,result,run,analyzed_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM analysis_jobs WHERE id=? AND state='analyzing' AND attempt_id=? AND fence=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      aid,
      job.id,
      input.report_id,
      input.content_revision,
      JSON.stringify(r),
      JSON.stringify(run),
      time,
      job.id,
      lease.attempt_id,
      lease.fence,
    ),
  ];
  for (const [index, c] of r.claims.entries()) {
    const location = resolveClaimLocation(c, input),
      date = c.event_start?.slice(0, 10) ?? "unknown";
    let iid = await hash(input.source_event_id ? `${input.source_id}:${input.source_event_id}:${index}` : `${input.report_id}:${index}`);
    const words = (v: string) =>
      new Set(
        v
          .toLocaleLowerCase()
          .normalize("NFKC")
          .replace(/[^\p{L}\p{N} ]/gu, " ")
          .split(/\s+/)
          .filter((t) => t.length > 3),
      );
    const cw = words(c.summary);
    const match = candidates.find((v) => {
      const x = v.view;
      if (
        x.cancelled ||
        !location ||
        !x.location ||
        x.activity !== c.activity ||
        x.location.country !== location.country ||
        Math.abs(x.location.lon - location.lon) > 0.02 ||
        Math.abs(x.location.lat - location.lat) > 0.02
      )
        return false;
      const sameTime =
        c.event_start &&
        x.event_start &&
        Math.abs(Date.parse(c.event_start) - Date.parse(x.event_start)) <
          12 * 3600000;
      if (!sameTime) return false;
      const w = words(x.headline),
        intersection = [...cw].filter((t) => w.has(t)).length;
      return (
        intersection >= 3 && intersection / new Set([...cw, ...w]).size >= 0.55
      );
    });
    if (match && !input.source_event_id) iid = match.id;
    retained.add(iid);
    const prior = await stmt(
      e,
      "SELECT version,view FROM incidents WHERE id=?",
      iid,
    ).first<any>();
    const sourceRow = await stmt(
      e,
      "SELECT record FROM sources WHERE id=?",
      input.source_id,
    ).first<any>();
    const source = parse(sourceRow.record);
    const old = prior ? parse(prior.view) : null;
    const reports = [
      ...(old?.reports ?? []).filter(
        (v: any) => v.report_id !== input.report_id,
      ),
      {
        report_id: input.report_id,
        source_id: input.source_id,
        source_name: source.name,
        canonical_url: input.canonical_url,
        content_revision: input.content_revision,
        title: input.title,
        excerpts: input.excerpts,
        input_coverage: input.input_coverage,
        published_at: input.published_at,
        original_language: input.original_language,
        source_event_id: input.source_event_id,
        source_metadata: input.source_metadata,
        source_reports: input.source_reports,
        rights: source.rights,
      },
    ];
    const version = (prior?.version ?? 0) + 1;
    const view: IncidentView = {
      id: iid,
      version,
      headline: c.summary,
      summary_en: r.summary_en,
      summary_it: r.summary_it,
      activity: c.activity,
      impact: c.impact,
      evidence_status: input.official
        ? "official_advisory"
        : c.relationships.some((v) => v.type === "retracts")
          ? "retracted"
          : c.relationships.some((v) => v.type === "corrects")
            ? "corrected"
            : c.relationships.some((v) => v.type === "contradicts")
              ? "disputed"
              : "unverified",
      location,
      event_start: c.event_start,
      event_end: c.event_end,
      published_at: input.published_at,
      ingested_at: input.ingested_at,
      analyzed_at: time,
      updated_at: time,
      expires_at:
        c.official_instruction?.expires_at ??
        input.official?.expires_at ??
        null,
      claims: [
        ...(old?.claims ?? []).filter((v: any) =>
          v.report_id ? v.report_id !== input.report_id : v.id !== c.id,
        ),
        {
          ...c,
          id: `${aid}:${c.id}`,
          model_claim_id: c.id,
          report_id: input.report_id,
          content_revision: input.content_revision,
        },
      ],
      reports,
      history: [],
      review_needed: r.targeted_review,
      cancelled: input.official?.cancelled ?? false,
    };
    const data = JSON.stringify(view),
      origin = await hash(input.canonical_url);
    statements.push(
      stmt(
        e,
        `INSERT INTO incidents(id,version,view,updated_at) SELECT ?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET version=excluded.version,view=excluded.view,updated_at=excluded.updated_at`,
        iid,
        version,
        data,
        time,
        aid,
      ),
      stmt(
        e,
        `INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) SELECT ?,?,?,?,? WHERE ${guard}`,
        iid,
        version,
        data,
        time,
        prior ? "source revision" : "analysis accepted",
        aid,
      ),
      stmt(
        e,
        `INSERT OR IGNORE INTO origin_groups(id,canonical_url) SELECT ?,? WHERE ${guard}`,
        origin,
        input.canonical_url,
        aid,
      ),
      stmt(
        e,
        `INSERT OR IGNORE INTO evidence_links(incident_id,report_id,revision,origin_id) SELECT ?,?,?,? WHERE ${guard}`,
        iid,
        input.report_id,
        input.content_revision,
        origin,
        aid,
      ),
      stmt(
        e,
        `INSERT OR REPLACE INTO claims(id,analysis_id,incident_id,claim) SELECT ?,?,?,? WHERE ${guard}`,
        `${aid}:${c.id}`,
        aid,
        iid,
        JSON.stringify(c),
        aid,
      ),
      stmt(
        e,
        `INSERT INTO outbox(event_type,entity_id,payload) SELECT ?,?,? WHERE ${guard}`,
        prior
          ? [
              "informational",
              "minor",
              "significant",
              "severe",
              "critical",
            ].indexOf(view.impact) >
            [
              "informational",
              "minor",
              "significant",
              "severe",
              "critical",
            ].indexOf(old.impact)
            ? "incident.escalated"
            : "incident.updated"
          : "incident.created",
        iid,
        JSON.stringify({
          incident: view,
          catchup: Date.now() - Date.parse(input.ingested_at) > 60000,
        }),
        aid,
      ),
    );
    const rules = await rows(
      e,
      "SELECT r.*,a.geometry FROM alert_rules r LEFT JOIN watch_areas a ON a.id=json_extract(r.rule,'$.watch_area_id') WHERE r.owner_id='owner'",
    );
    for (const rule of rules) {
      const policy = parse(rule.rule) as AlertRule;
      const last = await lastAlertDelivery(e, iid, rule.id, policy);
      const decision = alertDecision(
        view,
        policy,
        rule.geometry ? parse(rule.geometry) : null,
        last,
      );
      const delivery = await hash(
        `${iid}:${version}:${rule.id}:${rule.version}`,
      );
      statements.push(
        stmt(
          e,
          `INSERT OR IGNORE INTO alert_deliveries(id,incident_id,incident_version,rule_id,rule_version,state,reason,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`,
          delivery,
          iid,
          version,
          rule.id,
          rule.version,
          decision.state,
          decision.reason,
          time,
          aid,
        ),
      );
    }
  }
  const previousSupports = await rows(
    e,
    "SELECT DISTINCT i.id,i.view,i.version FROM incidents i JOIN evidence_links l ON l.incident_id=i.id WHERE l.report_id=? AND i.deleted_at IS NULL",
    input.report_id,
  );
  for (const prior of previousSupports) {
    if (retained.has(prior.id)) continue;
    const old = parse(prior.view) as IncidentView;
    if(input.official && !input.official.cancelled && r.claims.length===0 && (old.analyzed_at===null || old.analysis_status==="source_only") && old.reports.some((v:any)=>v.report_id===input.report_id&&v.content_revision===input.content_revision)){
      // A model declining extraction cannot withdraw an unchanged authoritative source record.
      const kept={...old,version:prior.version+1,updated_at:time,analyzed_at:time,analysis_status:"source_only",review_needed:true};
      statements.push(stmt(e,`UPDATE incidents SET view=?,version=?,updated_at=? WHERE id=? AND ${guard}`,JSON.stringify(kept),kept.version,time,prior.id,aid),stmt(e,`INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) SELECT ?,?,?,?,? WHERE ${guard}`,prior.id,kept.version,JSON.stringify(kept),time,"Unchanged official record retained; AI extraction requires review",aid),stmt(e,`INSERT INTO outbox(event_type,entity_id,payload) SELECT 'incident.updated',?,? WHERE ${guard}`,prior.id,JSON.stringify({incident:kept,catchup:true}),aid));
      continue;
    }
    const otherReports = old.reports.filter(
      (v: any) => v.report_id !== input.report_id,
    );
    const version = prior.version + 1;
    const corrected = {
      ...old,
      version,
      updated_at: time,
      reports: [
        ...otherReports,
        {
          report_id: input.report_id,
          source_id: input.source_id,
          canonical_url: input.canonical_url,
          title: input.title,
          excerpts: input.excerpts,
          input_coverage: input.input_coverage,
          content_revision: input.content_revision,
          published_at: input.published_at,
          retracted: true,
        },
      ],
      summary_en: otherReports.length
        ? old.summary_en
        : `The source no longer supports this claim. Latest source report: ${input.title}`,
      cancelled: !otherReports.length,
      evidence_status: otherReports.length ? "corrected" : "retracted",
    };
    statements.push(
      ...(await correctionAlerts(e, corrected, { sql: guard, values: [aid] })),
    );
    statements.push(
      stmt(
        e,
        `UPDATE incidents SET view=?,version=?,updated_at=? WHERE id=? AND ${guard}`,
        JSON.stringify(corrected),
        version,
        time,
        prior.id,
        aid,
      ),
      stmt(
        e,
        `INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) SELECT ?,?,?,?,? WHERE ${guard}`,
        prior.id,
        version,
        JSON.stringify(corrected),
        time,
        "source revision no longer supports previous claim",
        aid,
      ),
      stmt(
        e,
        `INSERT INTO outbox(event_type,entity_id,payload) SELECT 'incident.updated',?,? WHERE ${guard}`,
        prior.id,
        JSON.stringify({
          incident: corrected,
          correction: true,
          catchup: true,
        }),
        aid,
      ),
    );
  }
  statements.push(
    stmt(
      e,
      `UPDATE analysis_jobs SET state='analyzed',completed_at=?,lease_until=NULL,error=NULL,error_kind=NULL WHERE id=? AND EXISTS(SELECT 1 FROM analysis_results WHERE id=?)`,
      time,
      job.id,
      aid,
    ),
    stmt(
      e,
      `INSERT INTO outbox(event_type,entity_id,payload) SELECT 'analysis.completed',?,? WHERE ${guard}`,
      input.report_id,
      JSON.stringify({ report_id: input.report_id, relevant: r.relevant }),
      aid,
    ),
  );
  try {
    await measuredBatch(e, statements);
  } catch (error) {
    if (
      conflicts < 3 &&
      /UNIQUE constraint failed: incident_revisions/i.test(String(error))
    )
      return complete(e, lease, result, run, conflicts + 1);
    throw error;
  }
  const accepted = await stmt(
    e,
    "SELECT id FROM analysis_results WHERE id=?",
    aid,
  ).first();
  if (accepted) await settleBundles(e);
  return json({ accepted: !!accepted, analysis_id: aid });
}
function defaultSignalEligible(incident: IncidentView) {
  if(incident.superseded_by)return false;
  return !incident.reports.length || incident.reports.some((report: any) => {
    const contextual = report.source_id === "fr-sncf-siri" || report.source_id?.startsWith("fcdo-") || report.source_id?.startsWith("it-dpc-") || report.source_id === "de-dwd";
    if (!contextual) return true;
    // Retained transport/weather/admin records remain accessible through explicit source context.
    return report.source_id !== "fr-sncf-siri" && ["severe", "critical"].includes(incident.impact) && incident.claims.some(c => temporalStatus(c) === "current");
  });
}
/**
 * Index-backed supersets of incidentInWindow and inBbox, applied before LIMIT so a busy region or
 * stale backlog cannot hide matching incidents. A bbox seeks its grid cells in incidents_cell and,
 * with a window, only the window's keys within each cell, so it reads its own area's live rows
 * rather than a whole latitude band. Without a bbox, or when the cells cover the whole grid, the
 * recency index stops after LIMIT matches. The exact checks in snapshot still decide membership.
 */
async function liveScope(e: Env, hours: number, bbox?: number[]) {
  const where: string[] = [],
    params: (string | number)[] = [];
  let index = "";
  // Day-aligned bounds with a day of slack cover UTC offsets and date-only values and keep the memo key stable.
  const day = 86400000,
    today = Math.floor(Date.now() / day) * day,
    after = new Date(today - hours * 3600000 - day),
    before = new Date(today + hours * 3600000 + 2 * day);
  if (
    hours > 0 &&
    Number.isFinite(after.getTime()) &&
    Number.isFinite(before.getTime())
  ) {
    where.push(`${windowKey}>=?`, `(${eventTime} IS NULL OR ${eventTime}<=?)`);
    // The recency index stops after LIMIT matches; most recently updated
    // incidents fall in the window, so it reads less than a window index would.
    params.push(after.toISOString(), before.toISOString());
  }
  if (bbox) {
    const reach = await memoRead(e, "incident-reach", 1000, () =>
      stmt(
        e,
        `SELECT max(${locationRadius}) AS km FROM incidents WHERE deleted_at IS NULL`,
      ).first<{ km: number | null }>(),
    );
    const candidates = bboxCandidates(bbox, reach?.km ?? 0);
    if (candidates.cells) {
      // Integers computed here, inlined because a whole hemisphere exceeds D1's 100 bound parameters.
      where.push(`${locationCell} IN(${candidates.cells.join(",")})`);
      index = " INDEXED BY incidents_cell";
    }
    where.push(candidates.sql);
    params.push(...candidates.params);
  }
  const clause = where.map((w) => ` AND ${w}`).join("");
  return {
    where: clause,
    params,
    index,
    key: JSON.stringify([clause, params]),
  };
}
/** The live incident head shared by the snapshot and the structured brief, so one read serves both. */
function liveHead(e: Env, scope: Awaited<ReturnType<typeof liveScope>>) {
  return memoRead(e, `incident-head${scope.key}`, 1000, () =>
    rows(
      e,
      `SELECT view FROM incidents${scope.index} WHERE deleted_at IS NULL${scope.where} ORDER BY updated_at DESC LIMIT 1000`,
      ...scope.params,
    ),
  );
}
async function snapshot(e: Env, u: URL) {
  const at = u.searchParams.get("at");
  if (at && !Number.isFinite(Date.parse(at))) throw Error("invalid_time");
  const searchText = (
    u.searchParams.get("query") ??
    u.searchParams.get("q") ??
    ""
  ).trim();
  const terms = searchText.match(/[\p{L}\p{N}]+/gu) ?? [];
  const fts = terms
    .slice(0, 20)
    .map((t) => '"' + t.replaceAll('"', '""') + '"')
    .join(" AND ");
  const hours = Number(u.searchParams.get("hours"));
  const bbox = u.searchParams.get("bbox")?.split(",").map(Number);
  if (bbox && (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))))
    throw Error("invalid_bbox");
  const scope = await liveScope(e, at ? 0 : hours, at ? undefined : bbox);
  const records = at
    ? await rows(
        e,
        "SELECT view FROM incident_revisions r WHERE known_at<=? AND version=(SELECT max(version) FROM incident_revisions WHERE incident_id=r.incident_id AND known_at<=?) ORDER BY known_at DESC LIMIT 1000",
        at,
        at,
      )
    : fts
      ? await rows(
          e,
          `SELECT i.view FROM incidents i JOIN incidents_fts f ON f.incident_id=i.id WHERE incidents_fts MATCH ? AND i.deleted_at IS NULL${scope.where} ORDER BY rank LIMIT 1000`,
          fts,
          ...scope.params,
        )
      : await liveHead(e, scope);
  const rights = await currentRights(e);
  let incidents = records
    .map((v) => parse(v.view) as IncidentView)
    .filter((i) => permittedView(i, rights))
    .map((i) => ({
      ...refreshRights(i, rights),
      claims: i.claims.map((c) => ({
        ...c,
        temporal_status: temporalStatus(c, at ? Date.parse(at) : Date.now()),
      })),
    }));
  if (!at && !u.searchParams.get("source") && u.searchParams.get("include_routine") !== "1") incidents = incidents.filter(defaultSignalEligible);
  const query = u.searchParams.get("query") ?? u.searchParams.get("q");
  if (query && at) incidents = incidents.filter((i) => textMatch(i, query));
  incidents = incidents.filter(viewFilter(u.searchParams, bbox));
  const incoming =
    at || u.searchParams.get("include_incoming") === "0"
      ? []
      : (
          await rows(
            e,
            "SELECT r.input,j.id AS job_id,j.state,j.error_kind FROM analysis_jobs j JOIN observation_revisions r ON r.report_id=j.report_id AND r.revision=j.revision JOIN observations o ON o.id=j.report_id WHERE j.state<>'analyzed' AND NOT(j.state='bundled' AND j.completed_at IS NOT NULL) AND o.deleted_at IS NULL ORDER BY j.created_at DESC LIMIT 200",
          )
        )
          .filter((v) => {
            const p = rights.get(parse(v.input).source_id);
            return p?.access && p.storage && p.display;
          })
          .map((v) => ({
            ...parse(v.input),
            state: v.state,
            job_id: v.job_id,
            processing_status:
              v.state === "blocked"
                ? "Blocked by source rights"
                : v.state === "retrying"
                  ? "Retrying analysis"
                  : v.state === "permanently_failed"
                    ? "Analysis needs review"
                    : v.state === "excluded"
                      ? "Excluded by policy"
                      : v.state === "bundled" ? "Waiting for shared situation analysis"
                      : v.state === "analyzing"
                        ? "Analyzing"
                        : "AI pending",
            error_kind: v.error_kind,
          }));
  const cursor = await stmt(
    e,
    "SELECT coalesce(max(id),0) AS cursor FROM outbox",
  ).first<any>();
  return {
    incidents,
    incoming,
    status: await status(e),
    cursor: String(cursor.cursor),
    sources: (
      await rows(
        e,
        "SELECT s.record,h.* FROM sources s LEFT JOIN source_health h ON h.source_id=s.id",
      )
    ).map((v) => ({
      ...parse(v.record),
      health: {
        checked_at: v.checked_at,
        last_success_at: v.last_success_at,
        error: v.error,
        received: v.received,
        checkpoint: v.checkpoint ? parse(v.checkpoint) : null,
      },
    })),
    historical_at: at,
    limited: records.length >= 1000,
  };
}
async function events(r: Request, e: Env) {
  const after = Number(
    r.headers.get("last-event-id") ||
      new URL(r.url).searchParams.get("cursor") ||
      0,
  );
  if (!Number.isSafeInteger(after) || after < 0) throw Error("invalid_cursor");
  let cursor = after;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout>,
    closed = false;
  const started = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      const failure = (error: unknown) => {
        clearTimeout(timer);
        if (/D1.*(?:daily|quota|limit)/i.test(String(error))) {
          quotaPausedUntil = Date.parse(
            new Date(Date.now() + 86400000).toISOString().slice(0, 10) +
              "T00:00:00Z",
          );
          send('event: storage.paused\ndata: {"error":"database_quota"}\n\n');
        }
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      send("retry: 1000\n\n");
      let bounds: any;
      try {
        bounds = await stmt(
          e,
          "SELECT (SELECT id FROM outbox ORDER BY id LIMIT 1) AS first,(SELECT id FROM outbox ORDER BY id DESC LIMIT 1) AS last",
        ).first<any>();
      } catch (error) {
        failure(error);
        return;
      }
      if (cursor && bounds.first && cursor < bounds.first - 1) {
        send(`event: resync\ndata: {"reason":"history_unavailable"}\n\n`);
        cursor = bounds.last;
      }
      const tick = async () => {
        try {
          if (r.signal.aborted || Date.now() - started > 40000) {
            closed = true;
            controller.close();
            return;
          }
          const updates = await memoRead(e, "outbox:" + cursor, 900, () =>
            rows(
              e,
              "SELECT * FROM outbox WHERE id>? ORDER BY id LIMIT 200",
              cursor,
            ),
          );
          for (const v of updates) {
            const payload = parse(v.payload);
            const safe =
              v.event_type === "resync"
                ? { reason: payload.reason ?? "authoritative_resync" }
                : {
                    kind: v.event_type,
                    committed_at: v.created_at,
                    incident_id: v.event_type.startsWith("incident.")
                      ? v.entity_id
                      : undefined,
                    report_id:
                      v.event_type === "incoming" ? v.entity_id : undefined,
                    version: payload.incident?.version ?? null,
                    catchup:
                      payload.catchup === true ||
                      Date.parse(v.created_at) <= started,
                  };
            send(
              `id: ${v.id}\nevent: ${v.event_type}\ndata: ${JSON.stringify(safe)}\n\n`,
            );
            cursor = v.id;
          }
          send(`: heartbeat ${now()}\n\n`);
          timer = setTimeout(tick, 1000);
        } catch (error) {
          failure(error);
        }
      };
      r.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          if (!closed) {
            closed = true;
            controller.close();
          }
        },
        { once: true },
      );
      await tick();
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

async function routes(r: Request, e: Env) {
  const u = new URL(r.url),
    p = u.pathname;
  if (p === "/api/session" && r.method === "POST") {
    const body = (await r.json()) as any;
    if (!(await eq(body.token, e.EUROPE_WATCH_OWNER_TOKEN)))
      return json({ error: "unauthorized" }, 401);
    return new Response('{"ok":true}', {
      headers: {
        "content-type": "application/json",
        "set-cookie": `ew_session=${await cookie(e)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`,
      },
    });
  }
  if (p === "/api/session" && r.method === "DELETE")
    return new Response("{}", {
      headers: {
        "set-cookie":
          "ew_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
      },
    });
  const who = await role(r, e);
  if (r.method === "GET" && p === "/api/geospatial") {
    if (who !== "owner") return json({error:"forbidden"},who ? 403 : 401);
    const geo = await import("./geospatial");
    const bbox = u.searchParams.has("bbox") ? geo.parseBbox(u.searchParams.get("bbox")!) : geo.WORLD;
    if (!bbox) return json({error:"invalid_bbox"},400);
    return json(await geo.getGeospatialCatalog(bbox));
  }
  if (r.method === "GET" && (p === "/api/cameras" || p.startsWith("/api/cameras/"))) {
    if (who !== "owner") return json({error: "forbidden"}, who ? 403 : 401);
    const media = await import("./cameras");
    if (p === "/api/cameras") return json(await media.listPublicCameras());
    const camera = await media.getPublicCamera(decodeURIComponent(p.slice("/api/cameras/".length)));
    return camera ? json(camera) : json({error:"camera_not_found"},404);
  }
  if (!who) {
    if (p.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width"><title>World Watch · Private</title><style>body{background:#0d151c;color:#e7edf1;font:18px system-ui;display:grid;place-content:center;height:95vh}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #354650;background:#192730;color:inherit}form{display:grid;gap:16px;max-width:360px}p{color:#a6b5be}</style><form id="login"><h1>World Watch</h1><p>Private owner access</p><input aria-label="Owner access token" type="password" id="token" autocomplete="current-password" required><button>Open map</button><output id="status"></output></form><script>login.onsubmit=async e=>{e.preventDefault();const r=await fetch("/api/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:token.value})});if(r.ok)location.reload();else status.textContent="Access token not accepted"}</script>',
      {
        headers: {
          "content-type": "text/html;charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        },
      },
    );
  }
  if (
    p.startsWith("/api/") &&
    (e.STORAGE_PAUSED === "1" || quotaPausedUntil > Date.now())
  )
    return json(
      {
        error: "storage_quota_paused",
        message:
          "Storage is paused while the database read budget is repaired. Queued work is preserved.",
        retry_after_seconds: 3600,
      },
      503,
    );
  if (!p.startsWith("/api/")) {
    if (who !== "owner") return json({ error: "forbidden" }, 403);
    return e.ASSETS.fetch(r);
  }
  if (p === "/api/health")
    return json({
      ok: true,
      service: "world-watch",
      storage: "D1 durable",
      analysis_mode: e.ANALYSIS_MODE ?? "local-codex",
      ...(who === "owner" ? { status: await status(e) } : {}),
    });
  if (p === "/api/news-signals" && r.method === "GET") {
    if (who !== "owner") return json({ error: "forbidden" }, 403);
    const bbox = u.searchParams.get("bbox")?.split(",").map(Number) ?? null;
    if (bbox && (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))))
      throw Error("invalid_bbox");
    return json(await memoRead(e, "news-signals:" + bbox, 60000, () => newsCatalog(newsContext(e), bbox)));
  }
  if (p.startsWith("/api/worker/") && who !== "worker" && who !== "owner")
    return json({ error: "forbidden" }, 403);
  if (p === "/api/brief" && r.method === "GET") {
    if (who!=="owner")return json({error:"forbidden"},403);
    const brief=await currentBrief({stmt:(sql,...values)=>stmt(e,sql,...values)});
    // A model brief always wins; issuer fields stand in only while no analysis worker has ever connected.
    if(brief.current||await stmt(e,"SELECT id FROM workers LIMIT 1").first())return json(brief);
    const hours=Number(u.searchParams.get("hours"));
    // Viewers poll every minute; one build per five minutes keeps the live read off that cadence.
    const current=await memoRead(e,"structured-brief:"+hours,300000,async()=>{
      const rights=await currentRights(e);
      const views=(await liveHead(e,await liveScope(e,hours))).map(v=>parse(v.view) as IncidentView);
      return structuredBrief(views.filter(i=>permittedView(i,rights)&&defaultSignalEligible(i)&&incidentInWindow(i,hours)),hours,Date.now(),(await newsCatalog(newsContext(e))).signals);
    });
    return json({current,pending:false,updated_at:null});
  }
  if (p.startsWith("/api/worker/brief/") && r.method === "POST") {
    const b=await r.json() as any;
    const context={stmt:(sql:string,...values:any[])=>stmt(e,sql,...values)};
    if(p === "/api/worker/brief/claim")return json({lease:await claimBrief(context,b.worker_id)});
    if(p === "/api/worker/brief/renew"){const result=await renewBrief(context,b.lease);return json(result??{renewed:false},result?200:409);}
    if(p === "/api/worker/brief/complete"){const result=await completeBrief(context,b.lease,b.result,b.run);return json(result,result.stale?409:200);}
    if(p === "/api/worker/brief/fail"){const result=await failBrief(context,b.lease,b.kind,b.error);return json(result,result.stale?409:200);}
  }
  if (p === "/api/worker/tombstones" && r.method === "POST") {
    const b = (await r.json()) as any;
    const deleted = await rows(
      e,
      "SELECT o.id,o.deleted_at FROM observations o JOIN sources s ON s.id=o.source_id WHERE (o.deleted_at IS NOT NULL OR json_extract(s.record,'$.rights.ai')=0 OR json_extract(s.record,'$.rights.storage')=0 OR json_extract(s.record,'$.rights.access')=0 OR json_extract(s.record,'$.rights.display')=0) AND o.id>? ORDER BY o.id LIMIT 1000",
      b.after ?? "",
    );
    return json({
      report_ids: deleted.map((v) => v.id),
      next_after:
        deleted.length === 1000 ? deleted[deleted.length - 1].id : null,
    });
  }
  if (p === "/api/worker/heartbeat" && r.method === "POST") {
    const b = (await r.json()) as any;
    if (
      typeof b.worker_id !== "string" ||
      b.worker_id.length > 150 ||
      ![
        "online",
        "budget",
        "auth",
        "quota",
        "model",
        "isolation",
        "offline",
      ].includes(b.state)
    )
      throw Error("invalid_worker_state");
    const details = JSON.stringify({ budget: b.details?.budget ?? null });
    if (details.length > 4000) throw Error("worker_details_too_large");
    await stmt(
      e,
      "INSERT INTO workers(id,last_seen,state,details) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,state=excluded.state,details=excluded.details",
      b.worker_id,
      now(),
      b.state,
      details,
    ).run();
    return json({ ok: true });
  }
  if (p === "/api/worker/claim" && r.method === "POST") {
    const b = (await r.json()) as any;
    return json(await claim(e, b.worker_id, b.limit));
  }
  if (p === "/api/worker/renew" && r.method === "POST") {
    const b = (await r.json()) as any;
    const lease_until = new Date(Date.now() + 120000).toISOString();
    const active = await stmt(
      e,
      "UPDATE analysis_jobs SET lease_until=? WHERE id=? AND attempt_id=? AND fence=? AND state='analyzing' AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING id,worker_id",
      lease_until,
      b.job_id,
      b.attempt_id,
      b.fence,
    ).first<any>();
    if (active)
      await stmt(
        e,
        "UPDATE workers SET last_seen=?,state='online' WHERE id=?",
        now(),
        active.worker_id,
      ).run();
    return json(
      { active: !!active, lease_until: active ? lease_until : null },
      active ? 200 : 409,
    );
  }
  if (p === "/api/worker/complete" && r.method === "POST") {
    const b = (await r.json()) as any;
    return complete(e, b.lease, b.result, b.run);
  }
  if (p === "/api/worker/fail" && r.method === "POST") {
    const b = (await r.json()) as any;
    const kind = [
      "auth",
      "quota",
      "model",
      "transport",
      "invalid",
      "rights",
      "permanent",
      "worker_auth",
      "budget",
      "isolation",
    ].includes(b.kind)
      ? b.kind
      : "invalid";
    const attempt = await stmt(
      e,
      "SELECT invalid_attempts FROM analysis_jobs WHERE id=?",
      b.lease.job_id,
    ).first<any>();
    const state =
      kind === "invalid" && (attempt?.invalid_attempts ?? 0) >= 7
        ? "permanently_failed"
        : kind === "isolation"
          ? "blocked"
          : kind === "rights"
            ? "blocked"
            : kind === "permanent"
              ? "permanently_failed"
              : "retrying";
    const delay =
      kind === "quota"
        ? 15 * 60000
        : kind === "auth" ||
            kind === "model" ||
            kind === "budget" ||
            kind === "isolation"
          ? 5 * 60000
          : 30000;
    const changed = await stmt(
      e,
      "UPDATE analysis_jobs SET state=?,error_kind=?,error=?,available_at=?,lease_until=NULL,invalid_attempts=invalid_attempts+? WHERE id=? AND attempt_id=? AND fence=? AND state='analyzing' AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING id,worker_id",
      state,
      kind,
      String(b.error ?? "").slice(0, 300),
      new Date(Date.now() + delay).toISOString(),
      kind === "invalid" ? 1 : 0,
      b.lease.job_id,
      b.lease.attempt_id,
      b.lease.fence,
    ).first<any>();
    if (changed)
      await stmt(
        e,
        "UPDATE workers SET state=?,last_seen=? WHERE id=?",
        kind,
        now(),
        changed.worker_id,
      ).run();
    return json({ accepted: !!changed, state }, changed ? 200 : 409);
  }
  const collectorAllowed = who === "collector" || who === "owner";
  if (p === "/api/ingest" && r.method === "POST") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    const b = (await r.json()) as any;
    return json(await ingest(e, b.observations));
  }
  if (p === "/api/news/ingest" && r.method === "POST") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    return json(await ingestNews(newsContext(e), await r.json()));
  }
  if (p === "/api/sources" && r.method === "POST") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    const b = (await r.json()) as any;
    const values = b.sources ?? (Array.isArray(b) ? b : [b]);
    if (values.length > 40) throw Error("too_many_sources");
    for (const s of values) {
      if (!s.id || !s.rights || !Array.isArray(s.countries) || !s.url)
        throw Error("invalid_source");
      canonical(s.url);
      await stmt(
        e,
        "INSERT INTO sources(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        s.id,
        JSON.stringify(s),
      ).run();
      await stmt(e, "UPDATE observations SET expires_at=CASE WHEN ?=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',r.ingested_at,?) FROM observation_revisions r WHERE r.report_id=observations.id AND r.revision=observations.latest_revision) END WHERE source_id=? AND deleted_at IS NULL", s.rights.storage ? 1 : 0, `+${Math.max(0,s.rights.retention_days)} days`, s.id).run();
      if (Number.isFinite(s.config?.queue_priority))
        await stmt(e, "UPDATE analysis_jobs SET priority=? WHERE state IN('pending','retrying') AND priority<90 AND report_id IN(SELECT id FROM observations WHERE source_id=?)", s.config.queue_priority, s.id).run();
    }
    await measuredBatch(e, [
      stmt(e, "UPDATE analysis_jobs SET state='blocked',error_kind='source_policy',lease_until=NULL WHERE state IN('pending','retrying') AND report_id IN(SELECT o.id FROM observations o JOIN sources s ON s.id=o.source_id WHERE json_extract(s.record,'$.status') NOT IN('enabled','degraded') OR json_extract(s.record,'$.config.context_only')=1)"),
      stmt(
        e,
        "UPDATE analysis_jobs SET state='blocked',error_kind='rights',lease_until=NULL WHERE state IN('pending','retrying','analyzing') AND report_id IN(SELECT o.id FROM observations o JOIN sources s ON s.id=o.source_id WHERE json_extract(s.record,'$.rights.ai')=0 OR json_extract(s.record,'$.rights.storage')=0 OR json_extract(s.record,'$.rights.access')=0)",
      ),
      stmt(
        e,
        "UPDATE analysis_jobs SET state='pending',error_kind=NULL,available_at=? WHERE state='blocked' AND error_kind IN('rights','source_policy') AND report_id IN(SELECT o.id FROM observations o JOIN sources s ON s.id=o.source_id WHERE o.deleted_at IS NULL AND json_extract(s.record,'$.rights.ai')=1 AND json_extract(s.record,'$.rights.storage')=1 AND json_extract(s.record,'$.rights.access')=1 AND json_extract(s.record,'$.status') IN('enabled','degraded') AND coalesce(json_extract(s.record,'$.config.context_only'),0)=0)",
        now(),
      ),
    ]);
    return json({ registered: values.length });
  }
  const reconciliation = p.match(/^\/api\/sources\/([^/]+)\/reconcile$/);
  if (reconciliation && r.method === "POST") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    const b = (await r.json()) as any;
    const sourceId = decodeURIComponent(reconciliation[1]);
    const sourceRow = await stmt(
      e,
      "SELECT record FROM sources WHERE id=?",
      sourceId,
    ).first<any>();
    const source = sourceRow && parse(sourceRow.record);
    // BBK withdraws warnings from its complete active feed; GDACS and ADSB.lol end what they stop listing as current,
    // and the routing detector ends drops it no longer finds open in any country.
    const listing = [
      "gdacs_geojson",
      "adsblol_squawks",
      "ripestat_country_routing",
    ].includes(
      source?.config?.format,
    );
    if (
      !source ||
      (source.family !== "bbk" && !listing) ||
      b.complete !== true ||
      !Array.isArray(b.active_native_ids) ||
      b.active_native_ids.length > 1000 ||
      b.active_native_ids.some((v: any) => typeof v !== "string")
    )
      throw Error("invalid_complete_warning_index");
    const ids = new Map(
      (
        await rows(
          e,
          "SELECT id,native_id FROM observations WHERE source_id=? AND deleted_at IS NULL",
          sourceId,
        )
      ).map((v) => [v.id, v.native_id]),
    );
    const active = new Set(b.active_native_ids);
    const candidates = (
      await rows(
        e,
        "SELECT DISTINCT i.view FROM incidents i JOIN evidence_links l ON l.incident_id=i.id JOIN observations o ON o.id=l.report_id WHERE o.source_id=? AND i.deleted_at IS NULL",
        sourceId,
      )
    )
      .map((v) => parse(v.view) as IncidentView)
      .filter(
        (i) =>
          (listing ? i.current_listing === true : !i.cancelled) &&
          i.reports.length &&
          i.reports.every(
            (p: any) =>
              p.source_id === sourceId &&
              ids.has(p.report_id) &&
              !active.has(ids.get(p.report_id)),
          ),
      );
    const statements: Stmt[] = [];
    for (const old of candidates.slice(0, 8)) {
      const time = now();
      // Leaving a current list ends the event without cancelling it; the expiry records when World Watch saw it go.
      const view = listing
        ? {
            ...old,
            version: old.version + 1,
            current_listing: false,
            expires_at: time,
            updated_at: time,
          }
        : {
            ...old,
            version: old.version + 1,
            cancelled: true,
            evidence_status: "corrected",
            updated_at: time,
            summary_en:
              "This warning is no longer present in the issuer’s complete active feed. It is archived as inactive; removal alone does not establish an explicit cancellation.",
          };
      statements.push(
        stmt(
          e,
          "UPDATE incidents SET view=?,version=?,updated_at=? WHERE id=?",
          JSON.stringify(view),
          view.version,
          view.updated_at,
          view.id,
        ),
        stmt(
          e,
          "INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)",
          view.id,
          view.version,
          JSON.stringify(view),
          view.updated_at,
          !listing
            ? "complete issuer feed withdrawal"
            : source.config.format === "ripestat_country_routing"
              ? "measured drop no longer found open"
              : "issuer no longer lists the event as current",
        ),
        stmt(
          e,
          "INSERT INTO outbox(event_type,entity_id,payload) VALUES('incident.updated',?,?)",
          view.id,
          JSON.stringify({ incident: view, catchup: true }),
        ),
        ...(await correctionAlerts(e, view)),
      );
    }
    if (statements.length) await measuredBatch(e, statements);
    return json({
      changed: Math.min(8, candidates.length),
      more: candidates.length > 8,
    });
  }
  if (p === "/api/collector/run" && r.method === "POST") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    const started = Date.now(), lease = new Date(started + 150000).toISOString() + "|" + crypto.randomUUID();
    const acquired = await stmt(e, "INSERT INTO collector_config(id,registry_hash) VALUES('run-lease',?) ON CONFLICT(id) DO UPDATE SET registry_hash=excluded.registry_hash WHERE collector_config.registry_hash<? RETURNING id", lease, now()).first();
    if (!acquired) return json({ skipped: "collector_running" });
    const deadline = AbortSignal.timeout(90000);
    try {
      const { collectSources } = await import("../collector/index");
      const request = async (path: string, payload?: unknown) => {
        deadline.throwIfAborted();
        const response = await routes(new Request("https://collector.internal" + path, {
          method: payload === undefined ? "GET" : "POST",
          headers: { Authorization: "Bearer " + e.EUROPE_WATCH_COLLECTOR_TOKEN, "content-type": "application/json" },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        }), e);
        if (!response.ok) throw Error(`collector_api_${response.status}`);
        return response.json();
      };
      const results = await collectSources({ EW_API_URL: e.PUBLIC_ORIGIN ?? "https://collector.internal", EW_COLLECTOR_TOKEN: e.EUROPE_WATCH_COLLECTOR_TOKEN }, {
        maxRequests: 40,
        request,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]) }),
      });
      const settled_bundles = await settleBundles(e);
      const maintenance = await enforceRetention(e);
      await stmt(e, "DELETE FROM outbox WHERE id IN(SELECT id FROM outbox WHERE created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') LIMIT 1000)").run();
      await stmt(e, "INSERT INTO collector_config(id,registry_hash) VALUES('last-run',?) ON CONFLICT(id) DO UPDATE SET registry_hash=excluded.registry_hash", JSON.stringify({ at: now(), duration_ms: Date.now()-started, results, maintenance })).run();
      return json({ results, maintenance, settled_bundles, duration_ms: Date.now()-started });
    } finally {
      await stmt(e, "DELETE FROM collector_config WHERE id='run-lease' AND registry_hash=?", lease).run();
    }
  }
  if (p === "/api/operator/review-queue" && r.method === "POST") {
    if (who !== "owner") return json({ error: "forbidden" }, 403);
    const b = await r.json() as any;
    const { sourceEligibility } = await import("../collector/index");
    const candidates = await rows(e, "SELECT j.id,r.input,s.record FROM analysis_jobs j JOIN observation_revisions r ON r.report_id=j.report_id AND r.revision=j.revision JOIN observations o ON o.id=j.report_id JOIN sources s ON s.id=o.source_id WHERE j.state IN('pending','retrying') AND j.id>? AND o.deleted_at IS NULL ORDER BY j.id LIMIT 25", typeof b.after === "string" ? b.after : "");
    const excluded: {job_id: string; reason: string}[] = [];
    for (const candidate of candidates) {
      const decision = sourceEligibility(parse(candidate.record), parse(candidate.input), Date.now());
      if (!decision.eligible) {
        excluded.push({ job_id: candidate.id, reason: decision.reason });
        if (b.apply === true) await stmt(e, "UPDATE analysis_jobs SET state='excluded',error_kind=?,lease_until=NULL WHERE id=? AND state IN('pending','retrying')", `eligibility:${decision.policy_version}:${decision.reason}`, candidate.id).run();
      }
    }
    if (b.apply === true && excluded.length) await stmt(e, "INSERT INTO annotations(id,incident_id,body,created_at) VALUES(?,NULL,?,?)", crypto.randomUUID(), JSON.stringify({ action: "queue_admission_review", excluded }), now()).run();
    return json({ apply: b.apply === true, reviewed: candidates.length, excluded, after: candidates.at(-1)?.id ?? null, more: candidates.length === 25 });
  }
  if (p === "/api/operator/pipeline" && r.method === "GET") {
    if (who !== "owner") return json({ error: "forbidden" }, 403);
    return json({ generated_at: now(), sources: await rows(e, `SELECT s.id,json_extract(s.record,'$.name') AS name,json_extract(s.record,'$.poll_seconds') AS poll_seconds,
      (SELECT count(*) FROM observations o WHERE o.source_id=s.id AND o.deleted_at IS NULL) AS reports,
      (SELECT count(*) FROM analysis_jobs j JOIN observations o ON o.id=j.report_id WHERE o.source_id=s.id AND j.state IN('pending','retrying','analyzing')) AS pending,
      (SELECT count(*) FROM analysis_jobs j JOIN observations o ON o.id=j.report_id WHERE o.source_id=s.id AND j.state='excluded') AS excluded,
      (SELECT count(*) FROM analysis_results a JOIN observations o ON o.id=a.report_id WHERE o.source_id=s.id) AS analyzed,
      (SELECT count(*) FROM analysis_results a JOIN observations o ON o.id=a.report_id WHERE o.source_id=s.id AND json_extract(a.result,'$.relevant')=1) AS relevant
      FROM sources s ORDER BY reports DESC`), last_collection: await stmt(e,"SELECT registry_hash AS record FROM collector_config WHERE id='last-run'").first() });
  }
  if (p === "/api/collector/maintenance" && r.method === "POST") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    const result = await enforceRetention(e);
    await stmt(
      e,
      "DELETE FROM outbox WHERE id IN(SELECT id FROM outbox WHERE created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') LIMIT 1000)",
    ).run();
    return json(result);
  }
  if (p === "/api/collector/config") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    if (r.method === "GET")
      return json(
        (await stmt(
          e,
          "SELECT registry_hash FROM collector_config WHERE id='registry'",
        ).first()) ?? { registry_hash: null },
      );
    if (r.method === "POST") {
      const b = (await r.json()) as any;
      if (!/^[a-f0-9]{64}$/.test(b.registry_hash ?? ""))
        throw Error("invalid_registry_hash");
      await stmt(
        e,
        "INSERT INTO collector_config(id,registry_hash) VALUES('registry',?) ON CONFLICT(id) DO UPDATE SET registry_hash=excluded.registry_hash",
        b.registry_hash,
      ).run();
      return json({ ok: true });
    }
  }
  const health = p.match(/^\/api\/sources\/([^/]+)\/health$/);
  if (health && r.method === "POST") {
    if (!collectorAllowed) return json({ error: "forbidden" }, 403);
    const b = (await r.json()) as any;
    await stmt(
      e,
      "INSERT INTO source_health(source_id,checked_at,last_success_at,error,received,checkpoint) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,last_success_at=coalesce(excluded.last_success_at,source_health.last_success_at),error=excluded.error,received=source_health.received+excluded.received,checkpoint=coalesce(excluded.checkpoint,source_health.checkpoint)",
      decodeURIComponent(health[1]),
      b.checked_at ?? now(),
      b.last_success_at ?? null,
      b.error ? String(b.error).slice(0, 300) : null,
      b.received ?? 0,
      b.checkpoint ? JSON.stringify(b.checkpoint) : null,
    ).run();
    return json({ ok: true });
  }
  if (p === "/api/sources" && collectorAllowed)
    return json({
      sources: (
        await rows(
          e,
          "SELECT s.record,h.* FROM sources s LEFT JOIN source_health h ON h.source_id=s.id",
        )
      ).map((v) => ({
        ...parse(v.record),
        health: {
          checked_at: v.checked_at,
          last_success_at: v.last_success_at,
          error: v.error,
          received: v.received,
          checkpoint: v.checkpoint ? parse(v.checkpoint) : null,
        },
      })),
    });
  if (who !== "owner") return json({ error: "forbidden" }, 403);
  if(p==="/api/analyses/review"&&r.method==="POST"){
    const b=await r.json() as any;
    if(!Array.isArray(b.report_ids)||!b.report_ids.length||b.report_ids.length>10||b.report_ids.some((v:unknown)=>typeof v!=="string"||!/^[a-f0-9]{64}$/.test(v))||typeof b.reason!=="string"||!b.reason.trim()||b.reason.length>500||typeof b.version!=="string"||!/^[a-zA-Z0-9-]{1,80}$/.test(b.version))throw Error("invalid_review_request");
    const jobs=[];const time=now();
    for(const id of new Set<string>(b.report_ids)){
      const current=await stmt(e,"SELECT o.latest_revision,s.record FROM observations o JOIN sources s ON s.id=o.source_id WHERE o.id=? AND o.deleted_at IS NULL",id).first<any>();
      if(!current)throw Error("review_report_not_found");const source=parse(current.record) as SourceRecord;
      if(!source.rights.ai||!source.rights.access||!source.rights.storage||!["enabled","degraded"].includes(source.status)||source.config.context_only)return json({error:"review_source_blocked"},403);
      const contract=CONTRACT_VERSION+":review:"+b.version,job=await hash(`${id}:${current.latest_revision}:${contract}`);
      await measuredBatch(e,[stmt(e,"INSERT OR IGNORE INTO analysis_jobs(id,report_id,revision,contract_version,state,priority,available_at,created_at,error_kind) VALUES(?,?,?,?,'pending',95,?,?,?)",job,id,current.latest_revision,contract,time,time,"targeted_review"),stmt(e,"INSERT OR IGNORE INTO annotations(id,incident_id,body,created_at) VALUES(?,NULL,?,?)","review:"+job,JSON.stringify({action:"targeted_analysis_review",report_id:id,version:b.version,reason:b.reason}),time)]);
      jobs.push(job);
    }return json({jobs,version:b.version});
  }
  const retry = p.match(/^\/api\/jobs\/([^/]+)\/retry$/);
  if (retry && r.method === "POST") {
    const job = await stmt(
      e,
      "SELECT j.*,s.record FROM analysis_jobs j JOIN observations o ON o.id=j.report_id JOIN sources s ON s.id=o.source_id WHERE j.id=? AND o.deleted_at IS NULL",
      retry[1],
    ).first<any>();
    if (!job) return json({ error: "not_found" }, 404);
    const rights = parse(job.record).rights;
    if (!rights.ai || !rights.access || !rights.storage)
      return json({ error: "source_rights_block" }, 403);
    if (!["permanently_failed", "retrying", "blocked"].includes(job.state))
      return json({ error: "job_not_recoverable" }, 409);
    await measuredBatch(e, [
      stmt(
        e,
        "UPDATE analysis_jobs SET state='pending',attempts=0,invalid_attempts=0,error_kind=NULL,error=NULL,available_at=?,lease_until=NULL WHERE id=?",
        now(),
        job.id,
      ),
      stmt(
        e,
        "INSERT INTO annotations(id,incident_id,body,created_at) VALUES(?,NULL,?,?)",
        crypto.randomUUID(),
        "Owner requested analysis retry for job " + job.id,
        now(),
      ),
    ]);
    return json({ queued: true });
  }
  if (p === "/api/operator/import" && r.method === "POST") {
    if (e.MIGRATION_IMPORT !== "1")
      return json({ error: "migration_disabled" }, 403);
    const tables = new Set([
      "sources",
      "source_health",
      "observations",
      "observation_revisions",
      "analysis_jobs",
      "analysis_results",
      "origin_groups",
      "incidents",
      "incident_revisions",
      "claims",
      "evidence_links",
      "outbox",
      "workers",
      "watch_areas",
      "alert_rules",
      "alert_deliveries",
      "annotations",
    ]);
    const b = (await r.json()) as any;
    if (!tables.has(b.table)) throw Error("invalid_import_table");
    if (b.verify === true)
      return json(
        await stmt(e, `SELECT count(*) AS count FROM ${b.table}`).first(),
      );
    if (
      !Array.isArray(b.columns) ||
      !b.columns.length ||
      !Array.isArray(b.rows) ||
      b.rows.length > 25
    )
      throw Error("invalid_import_batch");
    const schema = await rows(e, `PRAGMA table_info(${b.table})`);
    if (
      b.columns.some(
        (c: unknown) =>
          typeof c !== "string" || !schema.some((v) => v.name === c),
      )
    )
      throw Error("invalid_import_columns");
    if (
      b.rows.some(
        (v: any) =>
          !Array.isArray(v) ||
          v.length !== b.columns.length ||
          v.some(
            (x: unknown) =>
              x !== null && typeof x !== "string" && typeof x !== "number",
          ),
      )
    )
      throw Error("invalid_import_row");
    const statements = b.rows.map((values: any[]) =>
      stmt(
        e,
        `INSERT OR IGNORE INTO ${b.table}(${b.columns.map((c: string) => '"' + c + '"').join(",")}) VALUES(${values.map(() => "?").join(",")})`,
        ...values,
      ),
    );
    if (statements.length) await measuredBatch(e, statements);
    return json({ accepted: b.rows.length });
  }
  if(p === "/api/operator/job-errors") return json({jobs:await rows(e,"SELECT id,report_id,revision,state,error_kind,error,available_at,invalid_attempts FROM analysis_jobs WHERE error_kind='invalid' ORDER BY available_at DESC LIMIT 16")});
  const trace=p.match(/^\/api\/trace\/([a-f0-9]+)$/);
  if(trace){
    const observation=await stmt(e,"SELECT o.source_id,o.canonical_url,o.first_observed_at,o.latest_revision,s.record FROM observations o JOIN sources s ON s.id=o.source_id WHERE o.id=? AND o.deleted_at IS NULL",trace[1]).first<any>();
    if(!observation)return json({error:"not_found"},404);
    const source=parse(observation.record);if(!source.rights.access||!source.rights.storage||!source.rights.display)return json({error:"not_found"},404);
    const analyses=await rows(e,"SELECT id,revision,analyzed_at,run,json_extract(result,'$.relevant') AS relevant,json_extract(result,'$.relevance_reason') AS relevance_reason,json_extract(result,'$.summary_en') AS summary_en,json_array_length(result,'$.claims') AS claims_count FROM analysis_results WHERE report_id=? ORDER BY analyzed_at DESC LIMIT 5",trace[1]);
    const input=await stmt(e,"SELECT input,ingested_at FROM observation_revisions WHERE report_id=? AND revision=?",trace[1],observation.latest_revision).first<any>();
    const parsed=input?parse(input.input):null;
    const jobs=await rows(e,"SELECT id,revision,state,created_at,completed_at,error_kind,invalid_attempts FROM analysis_jobs WHERE report_id=? ORDER BY created_at DESC LIMIT 5",trace[1]);
    return json({report_id:trace[1],source_id:observation.source_id,canonical_url:observation.canonical_url,published_at:parsed?.published_at??null,first_observed_at:observation.first_observed_at,ingested_at:input?.ingested_at??null,jobs,analyses:analyses.map(v=>({...v,run:parse(v.run)}))});
  }
  if (p === "/api/snapshot") return json(await snapshot(e, u));
  if (p === "/api/status") return json(await status(e));
  if (p === "/api/events") return events(r, e);
  if (p === "/api/sources")
    return json({
      sources: (
        await rows(
          e,
          "SELECT s.record,h.* FROM sources s LEFT JOIN source_health h ON h.source_id=s.id",
        )
      ).map((v) => ({
        ...parse(v.record),
        health: {
          checked_at: v.checked_at,
          last_success_at: v.last_success_at,
          error: v.error,
          received: v.received,
          checkpoint: v.checkpoint ? parse(v.checkpoint) : null,
        },
      })),
    });
  if (
    (p === "/api/incidents/merge" ||
      p === "/api/incidents/split" ||
      p === "/api/incidents/link") &&
    r.method === "POST"
  ) {
    const b = (await r.json()) as any;
    if (typeof b.reason !== "string" || !b.reason.trim())
      throw Error("audit_reason_required");
    const time = now(),
      changes: { view: IncidentView; reason: string }[] = [];
    if (p.endsWith("/merge")) {
      if (!Array.isArray(b.ids) || b.ids.length < 2 || b.ids.length > 20)
        throw Error("invalid_merge");
      const all: IncidentView[] = [];
      for (const id of [...new Set(b.ids)]) {
        const saved = await stmt(
          e,
          "SELECT view FROM incidents WHERE id=? AND deleted_at IS NULL",
          id,
        ).first<any>();
        if (!saved) throw Error("incident_not_found");
        all.push(parse(saved.view));
      }
      const target = all.find((v) => v.id === b.target_id) ?? all[0];
      const reports = [
        ...new Map(
          all.flatMap((v) => v.reports).map((v) => [v.report_id, v]),
        ).values(),
      ];
      const claims = all.flatMap((v) => v.claims);
      changes.push({
        view: {
          ...target,
          version: target.version + 1,
          reports,
          claims,
          updated_at: time,
          evidence_status: "corrected",
          review_needed: true,
        },
        reason: `manual merge: ${b.reason}`,
      });
      for (const old of all.filter((v) => v.id !== target.id))
        changes.push({
          view: {
            ...old,
            version: old.version + 1,
            cancelled: true,
            evidence_status: "corrected",
            updated_at: time,
            summary_en: `Merged into incident ${target.id}. ${old.summary_en}`,
            superseded_by: target.id,
          },
          reason: `merged into ${target.id}: ${b.reason}`,
        });
    } else if (p.endsWith("/link")) {
      // Separating two records, or handing the pair back to the rule; neither record changes otherwise.
      if (
        !Array.isArray(b.ids) ||
        b.ids.length !== 2 ||
        b.ids[0] === b.ids[1] ||
        typeof b.linked !== "boolean"
      )
        throw Error("invalid_link");
      const pair: IncidentView[] = [];
      for (const id of b.ids) {
        const saved = await stmt(
          e,
          "SELECT view FROM incidents WHERE id=? AND deleted_at IS NULL",
          id,
        ).first<any>();
        if (!saved) throw Error("incident_not_found");
        pair.push(parse(saved.view));
      }
      const verdict = b.linked
        ? sameEvent(pair[0], pair[1])
        : { type: "split_from" as const, basis: "operator", reason: b.reason.trim() };
      for (const [view, other] of [pair, [...pair].reverse()])
        changes.push({
          view: {
            ...withLinks(view, [
              ...(view.links ?? []).filter((l) => l.incident_id !== other.id),
              ...(verdict ? [{ ...verdict, incident_id: other.id }] : []),
            ]),
            version: view.version + 1,
            updated_at: time,
          },
          reason: b.linked
            ? `same-event rule restored for ${other.id}: ${b.reason}`
            : `separated from ${other.id}: ${b.reason}`,
        });
    } else {
      const saved = await stmt(
        e,
        "SELECT view FROM incidents WHERE id=? AND deleted_at IS NULL",
        b.id,
      ).first<any>();
      if (!saved) throw Error("incident_not_found");
      const old = parse(saved.view) as IncidentView;
      if (!Array.isArray(b.claim_ids) || !b.claim_ids.length)
        throw Error("claims_required");
      const selected = old.claims.filter((c) => b.claim_ids.includes(c.id)),
        remaining = old.claims.filter((c) => !b.claim_ids.includes(c.id));
      if (!selected.length || !remaining.length)
        throw Error("split_requires_two_nonempty_claim_sets");
      const id = crypto.randomUUID();
      changes.push(
        {
          view: {
            ...old,
            version: old.version + 1,
            claims: remaining,
            headline: remaining[0].summary,
            location: null,
            updated_at: time,
            review_needed: true,
            evidence_status: "corrected",
          },
          reason: `split claims into ${id}: ${b.reason}`,
        },
        {
          view: {
            ...old,
            id,
            version: 1,
            claims: selected,
            headline: selected[0].summary,
            location: null,
            updated_at: time,
            review_needed: true,
            evidence_status: "corrected",
          },
          reason: `split from ${old.id}: ${b.reason}`,
        },
      );
    }
    const ss: Stmt[] = [];
    for (const { view, reason } of changes) {
      ss.push(
        stmt(
          e,
          "INSERT INTO incidents(id,version,view,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,view=excluded.view,updated_at=excluded.updated_at",
          view.id,
          view.version,
          JSON.stringify(view),
          time,
        ),
        stmt(
          e,
          "INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)",
          view.id,
          view.version,
          JSON.stringify(view),
          time,
          reason,
        ),
        stmt(
          e,
          "INSERT INTO outbox(event_type,entity_id,payload) VALUES('incident.updated',?,?)",
          view.id,
          JSON.stringify({ incident: view, correction: true, catchup: true }),
        ),
      );
      for (const report of view.reports) {
        const origin = await hash(report.canonical_url);
        ss.push(
          stmt(
            e,
            "INSERT OR IGNORE INTO origin_groups(id,canonical_url) VALUES(?,?)",
            origin,
            report.canonical_url,
          ),
          stmt(
            e,
            "INSERT OR IGNORE INTO evidence_links(incident_id,report_id,revision,origin_id) VALUES(?,?,?,?)",
            view.id,
            report.report_id,
            report.content_revision ?? "unknown",
            origin,
          ),
        );
      }
    }
    await measuredBatch(e, ss);
    return json({ incidents: changes.map((v) => v.view) });
  }
  const detail = p.match(/^\/api\/incidents\/([^/]+)$/);
  if (detail) {
    const i = await stmt(
      e,
      "SELECT view FROM incidents WHERE id=? AND deleted_at IS NULL",
      detail[1],
    ).first<any>();
    if (!i) return json({ error: "not_found" }, 404);
    const item = parse(i.view) as IncidentView;
    if (u.searchParams.get("compact") === "1" && !defaultSignalEligible(item)) return json({error:"outside_default_monitoring"},404);
    if (u.searchParams.get("compact") !== "1") {
      const linked = await rows(e, "SELECT r.input FROM evidence_links l JOIN observation_revisions r ON r.report_id=l.report_id AND r.revision=l.revision JOIN observations o ON o.id=l.report_id JOIN analysis_jobs j ON j.report_id=l.report_id AND j.revision=l.revision WHERE l.incident_id=? AND j.state='bundled' AND j.completed_at IS NOT NULL AND o.deleted_at IS NULL AND o.latest_revision=l.revision ORDER BY j.created_at LIMIT 50", detail[1]);
      item.reports.push(...linked.map(v => ({...parse(v.input), analysis_reused: true, shared_content: true})).filter(v => !item.reports.some(r => r.report_id === v.report_id)));
    }
    const historical =
      u.searchParams.get("compact") !== "1"
        ? await rows(
            e,
            "SELECT version,known_at,reason,view FROM incident_revisions WHERE incident_id=? ORDER BY version",
            detail[1],
          )
        : [];
    const sourceIds = [
      ...new Set(
        [
          ...item.reports,
          ...historical.flatMap((v) => parse(v.view).reports ?? []),
        ].map((v: any) => v.source_id),
      ),
    ];
    const rights = await currentRights(e, sourceIds);
    if (!permittedView(item, rights)) return json({ error: "not_found" }, 404);
    return json({
      ...refreshRights(
        {
          ...item,
          claims: item.claims.map((c) => ({
            ...c,
            temporal_status: temporalStatus(c),
          })),
        },
        rights,
      ),
      history: historical
        .filter((v) => permittedView(parse(v.view), rights))
        .map((v) => ({ ...v, view: refreshRights(parse(v.view), rights) })),
      evidence_origins:
        u.searchParams.get("compact") === "1"
          ? []
          : await rows(
              e,
              "SELECT o.*,l.report_id FROM origin_groups o JOIN evidence_links l ON l.origin_id=o.id WHERE l.incident_id=?",
              detail[1],
            ),
    });
  }
  const deletion = p.match(/^\/api\/sources\/([^/]+)$/);
  if (deletion && r.method === "DELETE") {
    const id = decodeURIComponent(deletion[1]),
      time = now();
    const affectedSql =
      "SELECT DISTINCT incident_id FROM evidence_links WHERE report_id IN(SELECT id FROM observations WHERE source_id=?)";
    const affected = await stmt(
      e,
      `SELECT count(*) AS n FROM incidents WHERE id IN(${affectedSql})`,
      id,
    ).first<any>();
    // Erase source text from every derived surface before emitting one authoritative resync.
    // Whole incidents are conservatively removed when mixed provenance needs reconstruction.
    const ss = [
      stmt(e, `DELETE FROM outbox WHERE entity_id IN(${affectedSql})`, id),
      stmt(e, `DELETE FROM claims WHERE incident_id IN(${affectedSql})`, id),
      stmt(
        e,
        `DELETE FROM incident_revisions WHERE incident_id IN(${affectedSql})`,
        id,
      ),
      stmt(
        e,
        `UPDATE incidents SET view='{}',deleted_at=? WHERE id IN(${affectedSql})`,
        time,
        id,
      ),
      stmt(
        e,
        `DELETE FROM evidence_links WHERE incident_id IN(${affectedSql})`,
        id,
      ),
      stmt(
        e,
        "DELETE FROM outbox WHERE entity_id IN(SELECT id FROM observations WHERE source_id=?)",
        id,
      ),
      stmt(
        e,
        "DELETE FROM analysis_results WHERE report_id IN(SELECT id FROM observations WHERE source_id=?)",
        id,
      ),
      stmt(
        e,
        "UPDATE analysis_jobs SET state='excluded',error_kind='source_deleted',error=NULL WHERE report_id IN(SELECT id FROM observations WHERE source_id=?)",
        id,
      ),
      stmt(
        e,
        "DELETE FROM observation_revisions WHERE report_id IN(SELECT id FROM observations WHERE source_id=?)",
        id,
      ),
      stmt(
        e,
        "UPDATE observations SET canonical_url='',deleted_at=? WHERE source_id=?",
        time,
        id,
      ),
      stmt(e, "DELETE FROM source_health WHERE source_id=?", id),
      stmt(
        e,
        "DELETE FROM origin_groups WHERE id NOT IN(SELECT origin_id FROM evidence_links)",
      ),
      stmt(
        e,
        "INSERT INTO outbox(event_type,entity_id,payload) VALUES('resync',?,?)",
        id,
        JSON.stringify({ reason: "source_deleted", source_id: id }),
      ),
    ];
    await measuredBatch(e, ss);
    return json({ deleted: true, affected_incidents: affected?.n ?? 0 });
  }

  if (p === "/api/export") {
    const snap = await snapshot(e, u);
    const permitted = snap.incidents.filter((i) =>
      i.reports.every((v: any) => v.rights?.redistribute),
    );
    const format = u.searchParams.get("format") ?? "json";
    if (format === "geojson")
      return json({
        type: "FeatureCollection",
        features: permitted
          .filter((i) => i.location)
          .map((i) => ({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [i.location!.lon, i.location!.lat],
            },
            properties: {
              id: i.id,
              headline: i.headline,
              impact: i.impact,
              event_start: i.event_start,
              accuracy: i.location!.accuracy,
              urls: i.reports.map((r: any) => r.canonical_url),
              attribution: i.reports.map((r: any) => ({
                source: r.source_name ?? r.source_id,
                attribution: r.rights.attribution,
                license: r.rights.basis,
              })),
            },
          })),
      });
    if (format === "csv") {
      const escape = (s: any) => {
        let value = String(s ?? "");
        if (/^[=+@\-\t\r]/.test(value)) value = "'" + value;
        return `"${value.replaceAll('"', '""')}"`;
      };
      return new Response(
        [
          "id,headline,impact,event_start,source_urls,source_attribution,source_licenses",
          ...permitted.map((i) =>
            [
              i.id,
              i.headline,
              i.impact,
              i.event_start,
              i.reports.map((v: any) => v.canonical_url).join(" "),
              i.reports.map((v: any) => v.rights.attribution).join(" | "),
              i.reports.map((v: any) => v.rights.basis).join(" | "),
            ]
              .map(escape)
              .join(","),
          ),
        ].join("\n"),
        {
          headers: {
            "content-type": "text/csv",
            "content-disposition": "attachment;filename=world-watch.csv",
          },
        },
      );
    }
    return json({
      incidents: permitted,
      excluded_for_rights: snap.incidents.length - permitted.length,
      private_data_excluded: true,
    });
  }
  if (p === "/api/watch-areas") {
    if (r.method === "GET")
      return json({
        areas: await rows(
          e,
          "SELECT * FROM watch_areas WHERE owner_id='owner'",
        ),
      });
    if (r.method === "POST") {
      const b = (await r.json()) as any;
      if (!b.name || !b.geometry) throw Error("invalid_watch_area");
      const id = b.id ?? crypto.randomUUID();
      await stmt(
        e,
        "INSERT INTO watch_areas(id,owner_id,name,geometry,created_at) VALUES(?,'owner',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,geometry=excluded.geometry",
        id,
        b.name,
        JSON.stringify(b.geometry),
        now(),
      ).run();
      return json({ id });
    }
  }
  if (p === "/api/alert-rules") {
    if (r.method === "GET")
      return json({
        rules: (
          await rows(e, "SELECT * FROM alert_rules WHERE owner_id='owner'")
        ).map((v) => ({ ...v, rule: parse(v.rule) })),
        deliveries: await rows(
          e,
          "SELECT * FROM alert_deliveries ORDER BY created_at DESC LIMIT 200",
        ),
        channels: { in_app: true, external: "not configured" },
      });
    if (r.method === "POST") {
      const b = (await r.json()) as any;
      const id = b.id ?? crypto.randomUUID(),
        old = await stmt(
          e,
          "SELECT version FROM alert_rules WHERE id=? AND owner_id='owner'",
          id,
        ).first<any>();
      if (!b.rule || typeof b.rule !== "object") throw Error("invalid_rule");
      await stmt(
        e,
        "INSERT INTO alert_rules(id,owner_id,version,rule) VALUES(?,'owner',?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,rule=excluded.rule",
        id,
        (old?.version ?? 0) + 1,
        JSON.stringify(b.rule),
      ).run();
      return json({ id, version: (old?.version ?? 0) + 1 });
    }
  }
  if (p === "/api/notes" && r.method === "POST") {
    const b = (await r.json()) as any;
    const id = crypto.randomUUID();
    await stmt(
      e,
      "INSERT INTO annotations(id,incident_id,body,created_at) VALUES(?,?,?,?)",
      id,
      b.incident_id ?? null,
      String(b.body).slice(0, 10000),
      now(),
    ).run();
    return json({ id });
  }
  if (p === "/api/corrections" && r.method === "POST") {
    const b = (await r.json()) as any;
    const saved = await stmt(
      e,
      "SELECT view,version FROM incidents WHERE id=? AND deleted_at IS NULL",
      b.incident_id,
    ).first<any>();
    if (!saved) return json({ error: "not_found" }, 404);
    if (
      b.expected_version !== undefined &&
      b.expected_version !== saved.version
    )
      return json(
        { error: "revision_conflict", current_version: saved.version },
        409,
      );
    if (
      !b.reason ||
      !b.patch ||
      Object.keys(b.patch).some(
        (k) =>
          ![
            "headline",
            "summary_en",
            "summary_it",
            "impact",
            "activity",
            "event_start",
            "event_end",
            "cancelled",
            "location",
            "evidence_status",
          ].includes(k),
      )
    )
      throw Error("invalid_correction");
    if (
      b.patch.impact !== undefined &&
      !Impact.safeParse(b.patch.impact).success
    )
      throw Error("invalid_impact");
    if (b.patch.activity !== undefined && !Activity.safeParse(b.patch.activity).success)
      throw Error("invalid_activity");
    for (const field of ["event_start", "event_end"])
      if (b.patch[field] !== undefined && !validEventTime(b.patch[field]))
        throw Error("invalid_event_time");
    for (const field of ["headline", "summary_en", "summary_it"])
      if (
        b.patch[field] !== undefined &&
        b.patch[field] !== null &&
        (typeof b.patch[field] !== "string" || b.patch[field].length > 12000)
      )
        throw Error("invalid_correction_text");
    if (
      b.patch.evidence_status &&
      ![
        "unverified",
        "corroborated",
        "official_advisory",
        "disputed",
        "corrected",
        "retracted",
      ].includes(b.patch.evidence_status)
    )
      throw Error("invalid_evidence_status");
    if (
      b.patch.cancelled !== undefined &&
      typeof b.patch.cancelled !== "boolean"
    )
      throw Error("invalid_cancellation");
    const g = b.patch.location;
    if (
      g !== undefined &&
      g !== null &&
      (!Number.isFinite(g.lon) ||
        !Number.isFinite(g.lat) ||
        Math.abs(g.lon) > 180 ||
        Math.abs(g.lat) > 90 ||
        !["point", "city", "area", "country"].includes(g.accuracy) ||
        !Number.isFinite(g.radius_km) ||
        g.radius_km < 0 ||
        g.radius_km > 20040 ||
        typeof g.name !== "string")
    )
      throw Error("invalid_geography");
    const version = saved.version + 1,
      time = now();
    const original = parse(saved.view) as IncidentView;
    const view = {
      ...original,
      ...b.patch,
      ...((b.patch.impact || b.patch.activity) && original.claims.length === 1
        ? {
            claims: original.claims.map((c) => ({
              ...c,
              ...(b.patch.impact ? {impact: b.patch.impact,impact_uncertainty: b.reason} : {}),
              ...(b.patch.activity ? {activity: b.patch.activity} : {}),
            })),
          }
        : {}),
      version,
      updated_at: time,
      evidence_status: b.patch.evidence_status ?? "corrected",
    };
    const alertStatements = await correctionAlerts(e, view);
    await measuredBatch(e, [
      ...alertStatements,
      stmt(
        e,
        "UPDATE incidents SET view=?,version=?,updated_at=? WHERE id=? AND version=?",
        JSON.stringify(view),
        version,
        time,
        b.incident_id,
        saved.version,
      ),
      stmt(
        e,
        "INSERT INTO incident_revisions(incident_id,version,view,known_at,reason) VALUES(?,?,?,?,?)",
        b.incident_id,
        version,
        JSON.stringify(view),
        time,
        String(b.reason).slice(0, 1000),
      ),
      stmt(
        e,
        "INSERT INTO outbox(event_type,entity_id,payload) VALUES('incident.updated',?,?)",
        b.incident_id,
        JSON.stringify({ incident: view, correction: true }),
      ),
    ]);
    return json(view);
  }
  return json({ error: "not_found" }, 404);
}
export default {
  async fetch(r: Request, e: Env) {
    e = { ...e, _metrics: { read: 0, written: 0, queries: 0, unknown: 0 } };
    try {
      if (
        !["GET", "HEAD"].includes(r.method) &&
        r.headers.has("cookie") &&
        !r.headers.has("authorization") &&
        r.headers.get("origin") &&
        r.headers.get("origin") !== new URL(r.url).origin
      )
        return json({ error: "origin_mismatch" }, 403);
      if (
        r.method !== "GET" &&
        Number(r.headers.get("content-length") ?? 0) > 2_000_000
      )
        return json({ error: "body_too_large" }, 413);
      const upstream = await routes(r, e);
      if (r.method !== "GET" && upstream.ok) readMemo.delete(e.DB);
      const response = new Response(upstream.body, upstream);
      if (e._metrics && !e._metrics.unknown) {
        response.headers.set("x-ew-rows-read", String(e._metrics.read));
        response.headers.set("x-ew-rows-written", String(e._metrics.written));
      }
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("x-content-type-options", "nosniff");
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "request_failed";
      if (message === "queue_capacity_retry") {
        const response = json({ error: message, message: "Pending work capacity reached; collection checkpoints are preserved until processing catches up." }, 503);
        response.headers.set("Retry-After", "300");
        return response;
      }
      if (/D1.*(?:daily|quota|limit)/i.test(message)) {
        quotaPausedUntil = Date.parse(
          new Date(Date.now() + 86400000).toISOString().slice(0, 10) +
            "T00:00:00Z",
        );
        const response = json(
          {
            error: "database_quota",
            message:
              "Storage read budget reached. Automatic retries are paused; queued data is preserved.",
          },
          503,
        );
        response.headers.set(
          "Retry-After",
          String(Math.ceil((quotaPausedUntil - Date.now()) / 1000)),
        );
        return response;
      }
      console.error("request_failed", message.slice(0, 120));
      return json({ error: message.slice(0, 200) }, 400);
    }
  },
  async scheduled(
    _event: unknown,
    e: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) {
    if (!e.PUBLIC_ORIGIN || e.STORAGE_PAUSED === "1") return;
    await enforceRetention(e);
    await stmt(
      e,
      "DELETE FROM outbox WHERE created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')",
    ).run();
    ctx.waitUntil(
      import("../collector/index")
        .then((m) =>
          m.collectSources({
            EW_API_URL: e.PUBLIC_ORIGIN!,
            EW_COLLECTOR_TOKEN: e.EUROPE_WATCH_COLLECTOR_TOKEN,
          }),
        )
        .catch((error) =>
          console.error(
            "scheduled_collection_failed",
            String(error).slice(0, 200),
          ),
        ),
    );
  },
};
