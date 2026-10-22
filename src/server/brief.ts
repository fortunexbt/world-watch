import {
  validateBriefResult,
  type BriefInput,
  type BriefLease,
} from "../shared/brief";
type Statement = {
  bind(...v: any[]): Statement;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<any>;
};
export type BriefContext = {
  stmt: (sql: string, ...values: any[]) => Statement;
};
const iso = (n: number) => new Date(n).toISOString();
const parsed = (v: string) => JSON.parse(v);
const coreSource = (s: any) =>
  ![
    "disabled",
    "license_required",
    "awaiting_credentials",
    "unsupported",
  ].includes(s.status) &&
  !s.config?.context_only &&
  s.id !== "fr-sncf-siri";
const rows = async (c: BriefContext, sql: string, ...v: any[]) =>
  (await c.stmt(sql, ...v).all()).results;
export function briefWindow(clock = Date.now()) {
  const end = Math.floor(clock / 300000) * 300000;
  return {
    id: "brief:" + iso(end),
    window_start: iso(end - 300000),
    window_end: iso(end),
  };
}
export function briefPinEligible(view: any, clock = Date.now()) {
  if (
    view.cancelled ||
    (view.expires_at && Date.parse(view.expires_at) <= clock) ||
    view.review_needed ||
    ["disputed", "stale"].includes(view.evidence_status)
  )
    return false;
  const evidence = (claim: any) =>
    claim.evidence_ids?.some((id: string) =>
      (view.reports ?? []).some(
        (r: any) =>
          (!claim.report_id || r.report_id === claim.report_id) &&
          r.excerpts?.some((e: any) => e.id === id),
      ),
    );
  const ranks: any = { significant: 1, severe: 2, critical: 3 };
  if (
    ranks[view.impact] &&
    (view.claims ?? []).some(
      (claim: any) =>
        ranks[claim.impact] >= ranks[view.impact] &&
        Array.isArray(claim.impacts) &&
        claim.impacts.some((s: any) => typeof s === "string" && s.trim()) &&
        evidence(claim),
    )
  )
    return true;
  return (view.claims ?? []).some((claim: any) => {
    const x = claim.official_instruction;
    return (
      view.evidence_status === "official_advisory" &&
      x &&
      typeof x.instruction === "string" &&
      x.instruction.trim() &&
      typeof x.issuer === "string" &&
      x.issuer.trim() &&
      Array.isArray(x.evidence_ids) &&
      x.evidence_ids.length > 0 &&
      (!x.effective_at || Date.parse(x.effective_at) <= clock) &&
      x.expires_at &&
      Date.parse(x.expires_at) > clock &&
      evidence(claim) &&
      claim.evidence_ids?.some((id: string) => x.evidence_ids.includes(id))
    );
  });
}
async function sourceState(c: BriefContext, provenance: any[], checkAI = true) {
  const refs = provenance.flatMap((p) => p.reports ?? []);
  if (!refs.length) return "source_rights_changed";
  const ids = [...new Set(refs.map((r) => r.report_id))];
  const current = await rows(
    c,
    `SELECT o.id,o.source_id,o.latest_revision,o.deleted_at,s.record FROM observations o JOIN sources s ON s.id=o.source_id WHERE o.id IN(${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  const map = new Map(current.map((v) => [v.id, v]));
  for (const ref of refs) {
    const row = map.get(ref.report_id);
    if (!row || row.deleted_at || row.source_id !== ref.source_id)
      return "source_rights_changed";
    if (row.latest_revision !== ref.revision) return "source_revision_changed";
    const source = parsed(row.record),
      rights = source.rights;
    if (
      !coreSource(source) ||
      !rights?.access ||
      !rights.storage ||
      !rights.display ||
      (checkAI && !rights.ai)
    )
      return "source_rights_changed";
  }
  return "ok";
}
async function allowed(c: BriefContext, provenance: any[]) {
  return (await sourceState(c, provenance)) === "ok";
}

async function build(
  c: BriefContext,
  w: ReturnType<typeof briefWindow>,
  clock: number,
) {
  const changed = await rows(
    c,
    "SELECT id,version,view FROM incidents INDEXED BY incidents_recent WHERE deleted_at IS NULL AND updated_at>=? AND updated_at<? ORDER BY CASE json_extract(view,'$.impact') WHEN 'critical' THEN 3 WHEN 'severe' THEN 2 WHEN 'significant' THEN 1 ELSE 0 END DESC,updated_at DESC LIMIT 100",
    w.window_start,
    w.window_end,
  );
  const incidentTotal = await c
    .stmt(
      "SELECT count(*) AS n FROM incidents INDEXED BY incidents_recent WHERE deleted_at IS NULL AND updated_at>=? AND updated_at<?",
      w.window_start,
      w.window_end,
    )
    .first();
  const reportTotal = await c
    .stmt(
      "SELECT count(DISTINCT report_id) AS n FROM observation_revisions INDEXED BY observation_ingested_time WHERE ingested_at>=? AND ingested_at<?",
      w.window_start,
      w.window_end,
    )
    .first();
  const pending = await c
    .stmt(
      "SELECT (SELECT coalesce(sum(count),0) FROM queue_counters WHERE state IN('pending','retrying','analyzing'))+(SELECT count(*) FROM analysis_jobs INDEXED BY jobs_waiting_bundle WHERE state='bundled' AND completed_at IS NULL) AS n",
    )
    .first();
  const incidents: any[] = [],
    provenance: any[] = [];
  // Rights queries are batched by source-backed report identity, not a registry/full snapshot scan.
  const candidates = changed
    .map((row) => ({ row, view: parsed(row.view) }))
    .filter(
      ({ view }) =>
        !view.superseded_by &&
        view.analyzed_at &&
        Array.isArray(view.reports) &&
        view.reports.length > 0,
    );
  const allRefs = candidates.map(({ view, row }) => ({
    incident_id: row.id,
    version: row.version,
    reports: view.reports.map((r: any) => ({
      report_id: r.report_id,
      revision: r.content_revision,
      source_id: r.source_id,
    })),
  }));
  const reportIds = [
    ...new Set(allRefs.flatMap((p) => p.reports.map((r: any) => r.report_id))),
  ].slice(0, 80);
  const permission = reportIds.length
    ? await rows(
        c,
        `SELECT o.id,o.source_id,o.latest_revision,o.deleted_at,s.record FROM observations o JOIN sources s ON s.id=o.source_id WHERE o.id IN(${reportIds.map(() => "?").join(",")})`,
        ...reportIds,
      )
    : [];
  const permissions = new Map(permission.map((r) => [r.id, r]));
  for (const { row, view } of candidates) {
    if (incidents.length >= 50) break;
    if (
      view.reports.some((r: any) => {
        const p = permissions.get(r.report_id);
        const source = p ? parsed(p.record) : null;
        const rights = source?.rights;
        return (
          !p ||
          p.deleted_at ||
          p.source_id !== r.source_id ||
          p.latest_revision !== r.content_revision ||
          !coreSource(source) ||
          !rights?.access ||
          !rights.storage ||
          !rights.display ||
          !rights.ai
        );
      })
    )
      continue;
    const index = incidents.length;
    incidents.push({
      index,
      incident_id: row.id,
      headline: String(view.headline ?? "").slice(0, 200),
      summary: String(view.summary_en ?? "").slice(0, 600),
      impact: view.impact,
      evidence_status: view.evidence_status,
      activity: view.activity,
      event_start: view.event_start ?? null,
      event_end: view.event_end ?? null,
      updated_at: view.updated_at,
      source_count: new Set(view.reports.map((r: any) => r.source_id)).size,
      source_title: String(view.reports[0]?.title ?? "").slice(0, 160),
      cancelled: !!view.cancelled,
      pin_eligible: briefPinEligible(view, clock),
    });
    provenance.push({
      index,
      incident_id: row.id,
      version: row.version,
      reports: view.reports.map((r: any) => {
        const rights = parsed(permissions.get(r.report_id)!.record).rights;
        return {
          report_id: r.report_id,
          revision: r.content_revision,
          source_id: r.source_id,
          canonical_url: r.canonical_url,
          attribution: rights.attribution,
          license: rights.basis,
        };
      }),
    });
  }
  const input: BriefInput = {
    window_start: w.window_start,
    window_end: w.window_end,
    incidents,
    counts: {
      reports: reportTotal?.n ?? 0,
      incidents: incidentTotal?.n ?? 0,
      pending: pending?.n ?? 0,
      omitted: Math.max(0, (incidentTotal?.n ?? 0) - incidents.length),
    },
  };
  return { input, provenance };
}
export async function claimBrief(
  c: BriefContext,
  worker: string,
  clock = Date.now(),
): Promise<BriefLease | null> {
  if (!worker || worker.length > 160) throw Error("invalid_worker_id");
  await c
    .stmt(
      "UPDATE brief_windows SET state='superseded',lease_until=NULL,error_kind='window_obsolete',updated_at=? WHERE id IN(SELECT id FROM brief_windows INDEXED BY brief_latest WHERE state IN('pending','retrying','analyzing') AND window_end<? AND NOT(coalesce(json_extract(provenance,'$[0].bootstrap'),0)=1 AND window_end>=?) ORDER BY window_end LIMIT 10)",
      iso(clock),
      iso(clock - 900000),
      iso(clock - 3600000),
    )
    .run();
  const w = briefWindow(clock);
  for (let age = 0; age < 3; age++) {
    const target = briefWindow(clock - age * 300000);
    const existing = await c
      .stmt("SELECT id,state FROM brief_windows WHERE id=?", target.id)
      .first();
    if (existing) {
      if (existing.state !== "empty") break;
      continue;
    }
    const { input, provenance } = await build(c, target, clock);
    const time = iso(clock);
    await c
      .stmt(
        "INSERT OR IGNORE INTO brief_windows(id,window_start,window_end,state,input,provenance,created_at,updated_at,available_at)VALUES(?,?,?,?,?,?,?,?,?)",
        target.id,
        target.window_start,
        target.window_end,
        input.incidents.length ? "pending" : "empty",
        JSON.stringify(input),
        JSON.stringify(provenance),
        time,
        time,
        time,
      )
      .run();
    const saved = await c
      .stmt("SELECT provenance,state FROM brief_windows WHERE id=?", target.id)
      .first();
    const refs = parsed(saved.provenance).flatMap((p: any) =>
      p.reports.map((r: any) => [
        target.id,
        p.incident_id,
        p.version,
        r.report_id,
        r.revision,
        r.source_id,
      ]),
    );
    for (let i = 0; i < refs.length; i += 15) {
      const chunk = refs.slice(i, i + 15);
      await c
        .stmt(
          "INSERT OR IGNORE INTO brief_evidence(window_id,incident_id,incident_version,report_id,revision,source_id)VALUES" +
            chunk.map(() => "(?,?,?,?,?,?)").join(","),
          ...chunk.flat(),
        )
        .run();
    }
    if (saved.state !== "empty") break;
  }
  const priorComplete = await c
    .stmt("SELECT id FROM brief_windows WHERE state='complete' LIMIT 1")
    .first();
  const bootstrapUsed = await c
    .stmt(
      "SELECT id FROM collector_config WHERE id IN('brief-bootstrap-used','brief-ever-complete') LIMIT 1",
    )
    .first();
  if (!priorComplete && !bootstrapUsed) {
    const recent = await rows(
      c,
      "SELECT updated_at FROM incidents INDEXED BY incidents_recent WHERE deleted_at IS NULL AND updated_at>=? AND updated_at<? AND json_extract(view,'$.analyzed_at') IS NOT NULL ORDER BY updated_at DESC LIMIT 80",
      iso(clock - 3600000),
      w.window_end,
    );
    const seen = new Set<string>();
    for (const row of recent) {
      const target = briefWindow(Date.parse(row.updated_at) + 300000);
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      if (seen.size > 3) break;
      const present = await c
        .stmt("SELECT id FROM brief_windows WHERE id=?", target.id)
        .first();
      if (present) continue;
      const built = await build(c, target, clock);
      if (!built.input.incidents.length) continue;
      const claimed = await c
        .stmt(
          "INSERT OR IGNORE INTO collector_config(id,registry_hash)VALUES('brief-bootstrap-used',?) RETURNING id",
          target.id,
        )
        .first();
      if (!claimed) break;
      const provenance = built.provenance.map((p: any) => ({
        ...p,
        bootstrap: true,
      }));
      await c
        .stmt(
          "INSERT OR IGNORE INTO brief_windows(id,window_start,window_end,state,input,provenance,created_at,updated_at,available_at)VALUES(?,?,?,?,?,?,?,?,?)",
          target.id,
          target.window_start,
          target.window_end,
          "pending",
          JSON.stringify(built.input),
          JSON.stringify(provenance),
          iso(clock),
          iso(clock),
          iso(clock),
        )
        .run();
      const refs = provenance.flatMap((p: any) =>
        p.reports.map((r: any) => [
          target.id,
          p.incident_id,
          p.version,
          r.report_id,
          r.revision,
          r.source_id,
        ]),
      );
      for (let i = 0; i < refs.length; i += 15) {
        const chunk = refs.slice(i, i + 15);
        await c
          .stmt(
            "INSERT OR IGNORE INTO brief_evidence(window_id,incident_id,incident_version,report_id,revision,source_id)VALUES" +
              chunk.map(() => "(?,?,?,?,?,?)").join(","),
            ...chunk.flat(),
          )
          .run();
      }
      break;
    }
  }
  const candidate = await c
    .stmt(
      "SELECT * FROM brief_windows WHERE (window_end>=? OR (coalesce(json_extract(provenance,'$[0].bootstrap'),0)=1 AND window_end>=strftime('%Y-%m-%dT%H:%M:%fZ',?,'-1 hour'))) AND window_end<=? AND state IN('pending','retrying','analyzing') AND available_at<=? AND (state!='analyzing' OR lease_until<=?) ORDER BY window_end DESC LIMIT 1",
      iso(clock - 900000),
      iso(clock),
      w.window_end,
      iso(clock),
      iso(clock),
    )
    .first();
  if (!candidate) return null;
  if (!(await allowed(c, parsed(candidate.provenance)))) {
    await c
      .stmt(
        "UPDATE brief_windows SET state='superseded',lease_until=NULL,error_kind='input_changed',updated_at=? WHERE id=?",
        iso(clock),
        candidate.id,
      )
      .run();
    return null;
  }
  const token = crypto.randomUUID(),
    expires = iso(clock + 120000);
  const leased = await c
    .stmt(
      "UPDATE brief_windows SET state='analyzing',token=?,lease_until=?,worker_id=?,updated_at=? WHERE id=? AND state IN('pending','retrying','analyzing') AND (state!='analyzing' OR lease_until<=?) RETURNING id",
      token,
      expires,
      worker,
      iso(clock),
      candidate.id,
      iso(clock),
    )
    .first();
  return leased
    ? {
        id: candidate.id,
        token,
        expires_at: expires,
        report_ids: [
          ...new Set<string>(
            parsed(candidate.provenance).flatMap((p: any) =>
              p.reports.map((r: any) => r.report_id),
            ),
          ),
        ],
        input: parsed(candidate.input),
      }
    : null;
}
async function leaseRow(c: BriefContext, lease: any, clock: number) {
  if (!lease || typeof lease.id !== "string" || typeof lease.token !== "string")
    return null;
  return c
    .stmt(
      "SELECT * FROM brief_windows WHERE id=? AND token=? AND state='analyzing' AND lease_until>?",
      lease.id,
      lease.token,
      iso(clock),
    )
    .first();
}
export async function renewBrief(
  c: BriefContext,
  lease: any,
  clock = Date.now(),
) {
  const row = await leaseRow(c, lease, clock);
  if (!row) return null;
  const expires_at = iso(clock + 120000);
  const renewed = await c
    .stmt(
      "UPDATE brief_windows SET lease_until=?,updated_at=? WHERE id=? AND token=? AND state='analyzing' AND lease_until>? RETURNING id",
      expires_at,
      iso(clock),
      row.id,
      lease.token,
      iso(clock),
    )
    .first();
  return renewed ? { renewed: true, expires_at } : null;
}
export async function completeBrief(
  c: BriefContext,
  lease: any,
  result: unknown,
  run: any,
  clock = Date.now(),
) {
  const row = await leaseRow(c, lease, clock);
  if (!row) return { accepted: false, stale: true };
  const validated = validateBriefResult(result, parsed(row.input));
  if (
    !run ||
    run.requested_model !== "gpt-6-luna" ||
    run.requested_tier !== "fast" ||
    run.tool_attempts !== 0 ||
    run.schema_version !== "ew-brief-1" ||
    run.prompt_version !== "brief-1"
  )
    throw Error("invalid_brief_run");
  const sourceStatus = await sourceState(c, parsed(row.provenance));
  if (sourceStatus !== "ok") {
    await c
      .stmt(
        "UPDATE brief_windows SET state='superseded',lease_until=NULL,error_kind=?,updated_at=? WHERE id=? AND token=? AND state='analyzing'",
        sourceStatus,
        iso(clock),
        row.id,
        lease.token,
      )
      .run();
    if (sourceStatus === "source_revision_changed")
      return { accepted: false, stale: true };
    throw Error("brief_source_rights_changed");
  }
  const provenance = parsed(row.provenance).filter((p: any) =>
    validated.references.includes(p.index),
  );
  const versions = await rows(
    c,
    `SELECT id,version,deleted_at FROM incidents WHERE id IN(${provenance.map(() => "?").join(",")})`,
    ...provenance.map((p: any) => p.incident_id),
  );
  if (
    provenance.some(
      (p: any) =>
        !versions.some(
          (v) =>
            v.id === p.incident_id && !v.deleted_at && v.version === p.version,
        ),
    )
  ) {
    await c
      .stmt(
        "UPDATE brief_windows SET state='superseded',lease_until=NULL,error_kind='input_changed',updated_at=? WHERE id=? AND token=? AND state='analyzing'",
        iso(clock),
        row.id,
        lease.token,
      )
      .run();
    return { accepted: false, stale: true };
  }
  const committed = await c
    .stmt(
      "UPDATE brief_windows SET state='complete',result=?,run=?,updated_at=?,lease_until=NULL WHERE id=? AND token=? AND state='analyzing' AND lease_until>?" +
        provenance
          .map(
            () =>
              " AND EXISTS(SELECT 1 FROM incidents WHERE id=? AND version=? AND deleted_at IS NULL)",
          )
          .join("") +
        " AND NOT EXISTS(SELECT 1 FROM brief_evidence b LEFT JOIN observations o ON o.id=b.report_id LEFT JOIN sources s ON s.id=o.source_id WHERE b.window_id=brief_windows.id AND (o.id IS NULL OR o.deleted_at IS NOT NULL OR o.latest_revision!=b.revision OR o.source_id!=b.source_id OR s.id IS NULL OR coalesce(json_extract(s.record,'$.rights.access'),0)!=1 OR coalesce(json_extract(s.record,'$.rights.storage'),0)!=1 OR coalesce(json_extract(s.record,'$.rights.display'),0)!=1 OR coalesce(json_extract(s.record,'$.rights.ai'),0)!=1 OR coalesce(json_extract(s.record,'$.config.context_only'),0)=1 OR json_extract(s.record,'$.status') IN('disabled','license_required','awaiting_credentials','unsupported'))) RETURNING id",
      JSON.stringify(validated),
      JSON.stringify(run),
      iso(clock),
      row.id,
      lease.token,
      iso(clock),
      ...provenance.flatMap((p: any) => [p.incident_id, p.version]),
    )
    .first();
  if (committed)
    await c
      .stmt(
        "INSERT OR IGNORE INTO collector_config(id,registry_hash)VALUES('brief-ever-complete',?)",
        row.id,
      )
      .run();
  if (!committed)
    await c
      .stmt(
        "UPDATE brief_windows SET state='superseded',lease_until=NULL,error_kind='input_changed',updated_at=? WHERE id=? AND token=? AND state='analyzing' AND lease_until>?",
        iso(clock),
        row.id,
        lease.token,
        iso(clock),
      )
      .run();
  return { accepted: !!committed, ...(!committed ? { stale: true } : {}) };
}
export async function failBrief(
  c: BriefContext,
  lease: any,
  kind: string,
  error: string,
  clock = Date.now(),
) {
  const row = await leaseRow(c, lease, clock);
  if (!row) return { accepted: false, stale: true };
  const pause = ["quota", "auth", "model", "budget"].includes(kind)
    ? 900000
    : 60000;
  const changed = await c
    .stmt(
      "UPDATE brief_windows SET state='retrying',available_at=?,updated_at=?,lease_until=NULL,error_kind=?,error=? WHERE id=? AND token=? AND state='analyzing' AND lease_until>? RETURNING id",
      iso(clock + pause),
      iso(clock),
      String(kind).slice(0, 40),
      String(error).slice(0, 300),
      row.id,
      lease.token,
      iso(clock),
    )
    .first();
  return { accepted: !!changed, ...(!changed ? { stale: true } : {}) };
}
export async function currentBrief(c: BriefContext, clock = Date.now()) {
  const w = briefWindow(clock),
    latest = await c
      .stmt(
        "SELECT * FROM brief_windows WHERE state='complete' ORDER BY window_end DESC LIMIT 1",
      )
      .first();
  const state = await c
    .stmt(
      "SELECT state,updated_at,error_kind FROM brief_windows WHERE id=?",
      w.id,
    )
    .first();
  if (!latest || !(await allowed(c, parsed(latest.provenance))))
    return {
      current: null,
      pending:
        !state || ["pending", "retrying", "analyzing"].includes(state.state),
      updated_at: state?.updated_at ?? null,
    };
  const result = parsed(latest.result),
    provenance = parsed(latest.provenance),
    input = parsed(latest.input),
    refs = (result.references ?? [])
      .map((index: number) => {
        const p = provenance.find((p: any) => p.index === index);
        return p
          ? {
              ...p,
              headline:
                input.incidents.find((i: any) => i.index === index)?.headline ??
                "",
            }
          : null;
      })
      .filter(Boolean);
  const pins = provenance.filter((p: any) =>
    (result.pinned ?? []).includes(p.index),
  );
  const referencedIds = [
    ...new Set<string>([...refs, ...pins].map((p: any) => p.incident_id)),
  ];
  const currentViews = referencedIds.length
    ? await rows(
        c,
        `SELECT id,version,view FROM incidents WHERE deleted_at IS NULL AND id IN(${referencedIds.map(() => "?").join(",")})`,
        ...referencedIds,
      )
    : [];
  const currentPins = currentViews.filter((row) =>
    pins.some((p: any) => p.incident_id === row.id),
  );
  const changed_since_generated = refs.some(
    (ref: any) =>
      !currentViews.some(
        (row) => row.id === ref.incident_id && row.version === ref.version,
      ),
  );
  return {
    current: {
      kind: "model" as const,
      id: latest.id,
      window_start: latest.window_start,
      window_end: latest.window_end,
      headline: result.headline,
      changed_since_generated,
      references: refs,
      pins: currentPins
        .filter((r) => briefPinEligible(parsed(r.view), clock))
        .map((r) => {
          const v = parsed(r.view);
          return {
            incident_id: r.id,
            headline: v.headline,
            impact: v.impact,
            evidence_status: v.evidence_status,
            version: r.version,
          };
        }),
      counts: parsed(latest.input).counts,
      generated_at: latest.updated_at,
      as_of: latest.window_end,
      bootstrap: !!provenance[0]?.bootstrap,
      run: parsed(latest.run),
    },
    pending:
      !state || ["pending", "retrying", "analyzing"].includes(state.state),
    updated_at: latest.updated_at,
  };
}

export async function pruneBrief(c: BriefContext, clock = Date.now()) {
  return c
    .stmt(
      "DELETE FROM brief_windows WHERE id IN(SELECT id FROM brief_windows INDEXED BY brief_retention WHERE window_end<? ORDER BY window_end LIMIT 10)",
      iso(clock - 7 * 86400000),
    )
    .run();
}
