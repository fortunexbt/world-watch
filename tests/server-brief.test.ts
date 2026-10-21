import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  claimBrief,
  completeBrief,
  failBrief,
  currentBrief,
  renewBrief,
  briefPinEligible,
  briefWindow,
  type BriefContext,
} from "../src/server/brief";
const clock = Date.parse("2026-10-21T12:18:00Z"),
  update = "2026-10-21T12:12:00Z";
const run = {
  requested_model: "gpt-6-luna",
  requested_tier: "fast",
  actual_model: null,
  actual_tier: null,
  client_version: "fixture",
  prompt_version: "brief-1",
  schema_version: "ew-brief-1",
  duration_ms: 5,
  usage: null,
  tool_attempts: 0,
};
function setup(seed = true) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("deploy/migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort())
    db.exec(readFileSync("deploy/migrations/" + file, "utf8"));
  const stmt = (sql: string, ...v: any[]) => ({
    bind() {
      return this;
    },
    async first() {
      return db.prepare(sql).get(...v) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...v) };
    },
    async run() {
      return db.prepare(sql).run(...v);
    },
  });
  const c = { stmt } as BriefContext;
  const rights = {
    access: true,
    storage: true,
    display: true,
    ai: true,
    attribution: "Fixture publisher",
    basis: "Fixture only",
  };
  db.prepare("INSERT INTO sources(id,record)VALUES(?,?)").run(
    "s",
    JSON.stringify({ rights }),
  );
  const view: any = {
    id: "i",
    version: 1,
    headline: "Peaceful gathering planned in Dresden",
    summary_en: "A public gathering is planned.",
    activity: "planned_demonstration",
    impact: "informational",
    evidence_status: "official_advisory",
    event_start: "2026-10-23",
    event_end: null,
    updated_at: update,
    analyzed_at: update,
    cancelled: false,
    expires_at: null,
    review_needed: false,
    claims: [
      {
        impact: "informational",
        impacts: [],
        evidence_ids: ["e1"],
        official_instruction: null,
      },
    ],
    reports: [
      {
        report_id: "r",
        source_id: "s",
        content_revision: "v1",
        canonical_url: "https://fixture.invalid/report",
        title: "Public gathering topic",
        excerpts: [{ id: "e1", text: "A peaceful gathering is planned." }],
      },
    ],
  };
  if (seed) {
    db.prepare(
      "INSERT INTO observations(id,source_id,native_id,canonical_url,first_observed_at,latest_revision)VALUES(?,?,?,?,?,?)",
    ).run("r", "s", "native", "https://fixture.invalid/report", update, "v1");
    db.prepare(
      "INSERT INTO observation_revisions(report_id,revision,input,ingested_at)VALUES(?,?,?,?)",
    ).run("r", "v1", "{}", update);
    db.prepare(
      "INSERT INTO incidents(id,version,view,updated_at)VALUES(?,?,?,?)",
    ).run("i", 1, JSON.stringify(view), update);
  }
  return { db, c, view, rights };
}
test("brief window uses latest closed processing period; empty periods skip AI durably", async () => {
  const s = setup(false);
  assert.deepEqual(briefWindow(clock), {
    id: "brief:2026-10-21T12:15:00.000Z",
    window_start: "2026-10-21T12:10:00.000Z",
    window_end: "2026-10-21T12:15:00.000Z",
  });
  assert.equal(await claimBrief(s.c, "w", clock), null);
  assert.equal(
    s.db.prepare("SELECT count(*) AS n FROM brief_windows").get()!.n,
    3,
  );
  assert.equal(await claimBrief(s.c, "w", clock), null);
});
test("exactly one lease/bucket, immutable references and <=30word headline complete once", async () => {
  const s = setup(),
    lease = await claimBrief(s.c, "w", clock);
  assert.ok(lease);
  assert.equal(lease.input.incidents.length, 1);
  assert.equal(lease.input.incidents[0].source_title, "Public gathering topic");
  assert.equal(lease.input.incidents[0].pin_eligible, false);
  assert.equal(await claimBrief(s.c, "other", clock), null);
  assert.deepEqual(
    await completeBrief(
      s.c,
      lease,
      {
        headline: "Dresden gathering announced; effects remain unspecified.",
        references: [0],
        pinned: [],
      },
      run,
      clock + 1000,
    ),
    { accepted: true },
  );
  assert.equal(
    (
      await completeBrief(
        s.c,
        lease,
        { headline: "Duplicate", references: [0], pinned: [] },
        run,
        clock + 2000,
      )
    ).stale,
    true,
  );
  const current = await currentBrief(s.c, clock + 2000);
  assert.equal(current.current?.references[0].version, 1);
  assert.equal(current.current?.references[0].reports[0].revision, "v1");
  assert.equal(current.current?.counts.reports, 1);
  assert.equal(
    s.db.prepare("SELECT count(*)AS n FROM brief_windows").get()!.n,
    1,
  );
});
test("first brief finds recent eligible period even latest closed period empty, never hours history", async () => {
  const s = setup();
  s.db.prepare("UPDATE incidents SET updated_at=?").run("2026-10-21T12:07:00Z");
  const lease = await claimBrief(s.c, "w", clock);
  assert.equal(lease?.input.window_end, "2026-10-21T12:10:00.000Z");
  const old = setup();
  old.db
    .prepare("UPDATE incidents SET updated_at=?")
    .run("2026-10-21T10:07:00Z");
  assert.equal(await claimBrief(old.c, "w", clock), null);
});
test("word/citation/lowseverity pin validation rejects without completing lease", async () => {
  const s = setup(),
    lease = await claimBrief(s.c, "w", clock);
  for (const result of [
    { headline: Array(31).fill("word").join(" "), references: [0], pinned: [] },
    { headline: "Valid", references: [], pinned: [] },
    { headline: "Valid", references: [4], pinned: [] },
    { headline: "Valid", references: [0], pinned: [0] },
  ])
    await assert.rejects(completeBrief(s.c, lease, result, run, clock + 1));
  assert.equal(
    s.db.prepare("SELECT state FROM brief_windows").get()!.state,
    "analyzing",
  );
});
test("stale tokens cannot renew/commit/fail replacement and quota retry preserves snapshot", async () => {
  const s = setup(),
    a = await claimBrief(s.c, "w", clock);
  assert.ok(a);
  const b = await claimBrief(s.c, "replacement", clock + 121000);
  assert.ok(b);
  assert.notEqual(a.token, b.token);
  assert.equal(await renewBrief(s.c, a, clock + 121001), null);
  assert.equal(
    (
      await completeBrief(
        s.c,
        a,
        { headline: "Stale", references: [0], pinned: [] },
        run,
        clock + 121001,
      )
    ).stale,
    true,
  );
  assert.equal(
    (await failBrief(s.c, a, "quota", "stale", clock + 121001)).stale,
    true,
  );
  await failBrief(s.c, b, "budget", "allocation paused", clock + 121001);
  assert.equal(
    s.db.prepare("SELECT state FROM brief_windows WHERE id=?").get(b.id)!.state,
    "retrying",
  );
  assert.ok(s.db.prepare("SELECT input FROM brief_windows").get()!.input);
});
test("AI rights gate excludes source before model; withdrawal/deletion purges stored text", async () => {
  for (const method of ["rights", "delete"]) {
    const s = setup(),
      lease = await claimBrief(s.c, "w", clock);
    await completeBrief(
      s.c,
      lease,
      {
        headline: "Source-backed gathering update",
        references: [0],
        pinned: [],
      },
      run,
      clock + 1,
    );
    if (method === "rights")
      s.db
        .prepare("UPDATE sources SET record=? WHERE id=?")
        .run(JSON.stringify({ rights: { ...s.rights, ai: false } }), "s");
    else
      s.db
        .prepare("UPDATE observations SET deleted_at=? WHERE id=?")
        .run("2026-10-21T12:19:00Z", "r");
    assert.equal((await currentBrief(s.c, clock + 2)).current, null);
    assert.equal(
      s.db
        .prepare(
          "SELECT count(*)AS n FROM brief_windows WHERE result IS NOT NULL",
        )
        .get()!.n,
      0,
    );
  }
  const s = setup();
  s.db
    .prepare("UPDATE sources SET record=?")
    .run(JSON.stringify({ rights: { ...s.rights, ai: false } }));
  assert.equal(await claimBrief(s.c, "w", clock), null);
});
test("important pins require supported impact or current official instruction and recheck latest corrected state", async () => {
  const s = setup();
  s.view.impact = "significant";
  assert.equal(briefPinEligible(s.view, clock), false);
  s.view.claims[0] = {
    ...s.view.claims[0],
    impact: "significant",
    impacts: ["Public access blocked"],
    evidence_ids: ["e1"],
  };
  assert.equal(briefPinEligible(s.view, clock), true);
  s.db.prepare("UPDATE incidents SET view=?").run(JSON.stringify(s.view));
  const lease = await claimBrief(s.c, "w", clock);
  await completeBrief(
    s.c,
    lease,
    { headline: "Public access disrupted.", references: [0], pinned: [0] },
    run,
    clock + 1,
  );
  assert.equal((await currentBrief(s.c, clock + 2)).current?.pins.length, 1);
  s.view.cancelled = true;
  s.view.version = 2;
  s.db
    .prepare("UPDATE incidents SET version=2,view=?")
    .run(JSON.stringify(s.view));
  const owner = await currentBrief(s.c, clock + 3);
  assert.equal(owner.current?.pins.length, 0);
  assert.equal(owner.current?.changed_since_generated, true);
  assert.equal(owner.current?.references[0].version, 1);
  assert.equal(owner.current?.as_of, lease!.input.window_end);
});
test("correction while Luna runs fences publication; unanalysed projections never trigger a brief", async () => {
  const s = setup(),
    lease = await claimBrief(s.c, "w", clock);
  s.view.version = 2;
  s.db
    .prepare("UPDATE incidents SET version=2,view=?")
    .run(JSON.stringify(s.view));
  assert.equal(
    (
      await completeBrief(
        s.c,
        lease,
        { headline: "Old facts", references: [0], pinned: [] },
        run,
        clock + 1,
      )
    ).stale,
    true,
  );
  assert.equal(
    s.db.prepare("SELECT result FROM brief_windows WHERE id=?").get(lease!.id)!
      .result,
    null,
  );
  assert.deepEqual(lease!.report_ids, ["r"]);
  const pending = setup();
  pending.view.analyzed_at = null;
  pending.db
    .prepare("UPDATE incidents SET view=?")
    .run(JSON.stringify(pending.view));
  assert.equal(await claimBrief(pending.c, "w", clock), null);
});
test("unverified explicitly cited significant harm can pin while uncertain/routine labels cannot", () => {
  const s = setup();
  s.view.evidence_status = "unverified";
  s.view.impact = "significant";
  s.view.claims = [
    {
      impact: "significant",
      impacts: ["Public access blocked"],
      evidence_ids: ["e1"],
    },
  ];
  assert.equal(briefPinEligible(s.view, clock), true);
  s.view.evidence_status = "disputed";
  assert.equal(briefPinEligible(s.view, clock), false);
  s.view.evidence_status = "unverified";
  s.view.impact = "unknown";
  assert.equal(briefPinEligible(s.view, clock), false);
});
test("disabled/context/superseded archived views cannot reenter core brief through recent repairs", async () => {
  for (const condition of ["disabled", "context", "superseded"]) {
    const s = setup();
    if (condition === "superseded") {
      s.view.superseded_by = "new";
      s.db.prepare("UPDATE incidents SET view=?").run(JSON.stringify(s.view));
    } else
      s.db.prepare("UPDATE sources SET record=?").run(
        JSON.stringify({
          rights: s.rights,
          status: condition === "disabled" ? "disabled" : "enabled",
          config: { context_only: condition === "context" },
        }),
      );
    assert.equal(await claimBrief(s.c, "w", clock), null);
  }
  const s = setup(),
    lease = await claimBrief(s.c, "w", clock);
  s.db
    .prepare("UPDATE sources SET record=?")
    .run(JSON.stringify({ rights: s.rights, status: "disabled" }));
  await assert.rejects(
    completeBrief(
      s.c,
      lease,
      { headline: "Archived news", references: [0], pinned: [] },
      run,
      clock + 1,
    ),
    /rights_changed/,
  );
});
test("pending count excludes completed shared-analysis bundle members", async () => {
  const s = setup();
  for (const [id, completed] of [
    ["waiting", null],
    ["completed", "2026-10-21T12:12:00Z"],
  ])
    s.db
      .prepare(
        "INSERT INTO analysis_jobs(id,report_id,revision,contract_version,state,available_at,created_at,completed_at)VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(id, "r", id, "ew-1", "bundled", update, update, completed);
  const lease = await claimBrief(s.c, "w", clock);
  assert.equal(lease!.input.counts.pending, 1);
});
test("important earlier-window updates survive a burst of later routine updates within max50input", async () => {
  const s = setup();
  for (let i = 0; i < 55; i++) {
    const v = {
      ...s.view,
      id: "routine" + i,
      updated_at: "2026-10-21T12:14:00Z",
    };
    s.db
      .prepare(
        "INSERT INTO incidents(id,version,view,updated_at)VALUES(?,?,?,?)",
      )
      .run(v.id, 1, JSON.stringify(v), v.updated_at);
  }
  const v = {
    ...s.view,
    id: "important",
    impact: "critical",
    updated_at: "2026-10-21T12:10:10Z",
    claims: [
      {
        impact: "critical",
        impacts: ["Evacuation required"],
        evidence_ids: ["e1"],
      },
    ],
  };
  s.db
    .prepare("INSERT INTO incidents(id,version,view,updated_at)VALUES(?,?,?,?)")
    .run(v.id, 1, JSON.stringify(v), v.updated_at);
  const lease = await claimBrief(s.c, "w", clock);
  assert.equal(lease!.input.incidents[0].incident_id, "important");
  assert.equal(lease!.input.incidents.length, 50);
  assert.equal(lease!.input.counts.omitted, 7);
});
test("source revision advance before analysis supersedes brief instead of publishing stale source facts", async () => {
  const s = setup(),
    lease = await claimBrief(s.c, "w", clock);
  s.db
    .prepare("UPDATE observations SET latest_revision='v2' WHERE id='r'")
    .run();
  assert.equal(
    (
      await completeBrief(
        s.c,
        lease,
        { headline: "Old facts", references: [0], pinned: [] },
        run,
        clock + 1,
      )
    ).stale,
    true,
  );
  assert.equal(
    s.db.prepare("SELECT state FROM brief_windows WHERE id=?").get(lease!.id)!
      .state,
    "superseded",
  );
  const before = setup();
  before.db
    .prepare("UPDATE observations SET latest_revision='v2' WHERE id='r'")
    .run();
  assert.equal(await claimBrief(before.c, "w", clock), null);
});
test("publication atomically fences source revision change after permission preflight", async () => {
  const s = setup(),
    lease = await claimBrief(s.c, "w", clock);
  const racing = {
    stmt: (sql: string, ...args: any[]) => {
      if (sql.startsWith("UPDATE brief_windows SET state='complete'"))
        s.db
          .prepare("UPDATE observations SET latest_revision='v2' WHERE id='r'")
          .run();
      return s.c.stmt(sql, ...args);
    },
  };
  assert.equal(
    (
      await completeBrief(
        racing,
        lease,
        { headline: "Old facts", references: [0], pinned: [] },
        run,
        clock + 1,
      )
    ).stale,
    true,
  );
  assert.equal(
    s.db.prepare("SELECT result FROM brief_windows WHERE id=?").get(lease!.id)!
      .result,
    null,
  );
});
test("quota retry beyond freshness becomes explicitly obsolete while source queue remains intact", async () => {
  const s = setup(),
    lease = await claimBrief(s.c, "w", clock);
  const jobs = s.db.prepare("SELECT count(*)AS n FROM analysis_jobs").get()!.n;
  await failBrief(s.c, lease, "quota", "provider paused", clock);
  assert.equal(await claimBrief(s.c, "w", clock + 15 * 60000), null);
  const old = s.db
    .prepare("SELECT state,error_kind,input FROM brief_windows WHERE id=?")
    .get(lease!.id)!;
  assert.equal(old.state, "superseded");
  assert.equal(old.error_kind, "window_obsolete");
  assert.ok(old.input);
  assert.equal(
    s.db.prepare("SELECT count(*)AS n FROM analysis_jobs").get()!.n,
    jobs,
  );
});
test("first ever brief may bootstrap one clearly dated real closed window within1h, then never repeat history", async () => {
  const s = setup(),
    late = Date.parse("2026-10-21T12:44:00Z"),
    lease = await claimBrief(s.c, "w", late);
  assert.ok(lease);
  assert.equal(lease.input.window_start, "2026-10-21T12:10:00.000Z");
  assert.equal(lease.input.window_end, "2026-10-21T12:15:00.000Z");
  assert.equal(
    (
      await completeBrief(
        s.c,
        lease,
        {
          headline: "Previously processed Dresden gathering update.",
          references: [0],
          pinned: [],
        },
        run,
        late + 1,
      )
    ).accepted,
    true,
  );
  const owner = await currentBrief(s.c, late + 2);
  assert.equal(owner.current?.bootstrap, true);
  assert.equal(owner.current?.as_of, "2026-10-21T12:15:00.000Z");
  assert.equal(await claimBrief(s.c, "w", late + 3), null);
  assert.equal(
    s.db
      .prepare(
        "SELECT count(*)AS n FROM collector_config WHERE id='brief-bootstrap-used'",
      )
      .get()!.n,
    1,
  );
  assert.equal(
    s.db
      .prepare("SELECT count(*)AS n FROM brief_windows WHERE state='complete'")
      .get()!.n,
    1,
  );
});
