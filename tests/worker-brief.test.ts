import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  BriefInputSchema,
  validateBriefResult,
  type BriefInput,
} from "../src/shared/brief.js";
import {
  compactBrief,
  runBriefOnce,
  briefSpoolKey,
  pruneBriefSpools,
} from "../src/worker/brief.js";
import { saveSpool, RemoteWorker } from "../src/worker/worker.js";
import { DailyBudget } from "../src/worker/budget.js";
import { WorkerError } from "../src/worker/adapter.js";
const input: BriefInput = {
  window_start: "2026-10-21T12:00:00Z",
  window_end: "2026-10-21T12:05:00Z",
  incidents: [
    {
      index: 0,
      incident_id: "host-identity-do-not-send",
      headline: "Unconfirmed fire dispatch in Gouda",
      summary: "Unconfirmed fire dispatch in Gouda",
      source_title: "Publisher fire dispatch",
      impact: "unknown",
      evidence_status: "reported",
      activity: "property_damage_fire",
      event_start: "2026-10-21T10:00:00Z",
      event_end: null,
      updated_at: "2026-10-21T12:03:17Z",
      source_count: 1,
      cancelled: false,
      pin_eligible: false,
    },
    {
      index: 1,
      incident_id: "host-important",
      headline: "Flood warning",
      summary: "Official flood warning affects two districts until18:00.",
      impact: "significant",
      evidence_status: "official_advisory",
      activity: "official_advisory",
      event_start: "2026-10-21T11:00:00Z",
      event_end: "2026-10-21T18:00:00Z",
      updated_at: "2026-10-21T12:04:00Z",
      source_count: 1,
      cancelled: false,
      pin_eligible: true,
    },
  ],
  counts: { reports: 3, incidents: 2, pending: 4, omitted: 0 },
};
const result = {
  headline:
    "Officials warn of flooding in two districts; a separate Gouda fire dispatch remains unconfirmed.",
  references: [0, 1],
  pinned: [1],
};
const run = {
  invocation_id: "actual-test-invocation",
  requested_model: "gpt-6-luna",
  requested_tier: "fast",
  actual_model: null,
  actual_tier: null,
  client_version: "fixture",
  prompt_version: "brief-1",
  schema_version: "ew-brief-1",
  duration_ms: 10,
  usage: null,
  tool_attempts: 0,
};
test("brief result has30word ceiling, existing headline references and only host eligible pins", () => {
  assert.deepEqual(validateBriefResult(result, input), result);
  assert.throws(() =>
    validateBriefResult(
      { ...result, headline: Array(31).fill("word").join(" ") },
      input,
    ),
  );
  for (const patch of [
    { references: [] },
    { references: [0], pinned: [1] },
    { references: [2] },
    { references: [0, 0] },
    { pinned: [0] },
    { pinned: [1, 1] },
    { headline: "One headline\nSecond line" },
  ])
    assert.throws(() => validateBriefResult({ ...result, ...patch }, input));
  assert.throws(() => BriefInputSchema.parse({ ...input, incidents: [] }));
  assert.throws(() =>
    BriefInputSchema.parse({ ...input, window_end: "2026-10-21T12:06:00Z" }),
  );
});
test("compact brief retains qualifications/planned dates and drops host identities and redundant clocks/body duplication", () => {
  const compact = compactBrief(input),
    text = JSON.stringify(compact);
  assert(!text.includes("host-identity"));
  assert(!("counts" in compact));
  assert(!("coverage" in compact));
  assert.equal(
    compactBrief({ ...input, counts: { ...input.counts, omitted: 3 } }).coverage
      ?.omitted,
    3,
  );
  assert(!text.includes("12:03:17"));
  assert.equal(compact.incidents[0].summary, undefined);
  assert.equal(compact.incidents[0].source_title, "Publisher fire dispatch");
  assert(text.toLowerCase().includes("unconfirmed"));
  assert(text.includes("2026-10-21T18:00:00Z"));
  assert.equal(compact.window_end, input.window_end);
  assert.notEqual(
    briefSpoolKey(input),
    briefSpoolKey({
      ...input,
      incidents: [
        { ...input.incidents[0], headline: "Cancelled fire dispatch" },
      ],
    }),
  );
});
test("completed brief survives failed submission and restart; current lease token replays without another inference", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-brief-"));
  let calls = 0,
    leaseToken = "first",
    fail = true;
  const completions: any[] = [];
  try {
    const host = {
      id: "fixture",
      spool: dir,
      budget: new DailyBudget(path.join(dir, "budget.json"), {
        requests: 1,
        inputTokens: 10000,
        reserveRequests: 0,
        reserveInputTokens: 0,
      }),
      api: async (route: string, body: any) => {
        if (route === "brief/claim")
          return {
            lease: {
              id: "window1",
              token: leaseToken,
              expires_at: "2026-10-21T12:10:00Z",
              report_ids: ["source-report-1"],
              input,
            },
          };
        if (route === "brief/complete") {
          completions.push(body);
          if (fail)
            throw new WorkerError("storage_quota", "storage_quota_paused");
          return { accepted: true };
        }
        return { renewed: true };
      },
    };
    const options = {
      persist: (key: string, value: unknown) => saveSpool(dir, key, value),
      analyzer: async (
        _input: BriefInput,
        options: { budget: DailyBudget },
      ) => {
        await options.budget.reserve("actual-test-invocation", 6000);
        calls++;
        return { result, run };
      },
    };
    await assert.rejects(runBriefOnce(host, options), /storage_quota_paused/);
    assert.equal(calls, 1);
    assert.equal(
      JSON.parse(
        await readFile(path.join(dir, briefSpoolKey(input) + ".json"), "utf8"),
      ).result.headline,
      result.headline,
    );
    assert.equal(await host.budget.available(6000), false);
    fail = false;
    leaseToken = "fresh";
    assert.equal((await runBriefOnce({ ...host }, options)).completed, 1);
    assert.equal(calls, 1);
    assert.equal(completions[1].lease.token, "fresh");
    await assert.rejects(
      readFile(path.join(dir, briefSpoolKey(input) + ".json")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("empty queue skips inference; exhausted budget retries a lease without invoking a model or erasing queued work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-brief-idle-"));
  let apiCalls = 0,
    models = 0;
  try {
    const budget = new DailyBudget(path.join(dir, "budget.json"), {
      requests: 1,
      inputTokens: 10000,
      reserveRequests: 0,
      reserveInputTokens: 0,
    });
    const host = {
      id: "fixture",
      spool: dir,
      budget,
      api: async (route: string) => {
        apiCalls++;
        if (apiCalls === 1) return { lease: null };
        return route === "brief/claim"
          ? {
              lease: {
                id: "window",
                token: "current",
                expires_at: "2026-10-21T12:10:00Z",
                report_ids: ["source-report-1"],
                input,
              },
            }
          : {};
      },
    };
    const options = {
      persist: (key: string, value: unknown) => saveSpool(dir, key, value),
      analyzer: async () => {
        models++;
        return { result, run };
      },
    };
    assert.deepEqual(await runBriefOnce(host, options), {
      claimed: 0,
      completed: 0,
    });
    assert.equal(models, 0);
    await budget.reserve("spent", 6000);
    await assert.rejects(runBriefOnce(host, options), /budget_exhausted/);
    assert.equal(apiCalls, 3);
    assert.equal(models, 0);
    assert.equal((await budget.summary()).requests, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source tombstone removes derived brief spool and prevents inference or submission of withdrawn evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-brief-deleted-"));
  let models = 0,
    submits = 0;
  try {
    await saveSpool(dir, briefSpoolKey(input), {
      input_hash: briefSpoolKey(input),
      report_ids: ["withdrawn-report"],
      result,
      run,
    });
    const worker = new RemoteWorker({
      base: "http://127.0.0.1:1",
      token: "fixture",
      id: "fixture",
      spool: dir,
      briefAnalyzer: async () => {
        models++;
        return { result, run };
      },
    });
    worker.api = async (route) => {
      if (route === "brief/claim")
        return {
          lease: {
            id: "window",
            token: "token",
            expires_at: "2026-10-21T12:10:00Z",
            report_ids: ["withdrawn-report"],
            input,
          },
        };
      if (route === "tombstones")
        return { report_ids: ["withdrawn-report"], next_after: null };
      if (route === "brief/complete") submits++;
      return {};
    };
    await assert.rejects(worker.briefOnce(), /brief_source_withdrawn/);
    assert.equal(models, 0);
    assert.equal(submits, 0);
    await assert.rejects(
      readFile(path.join(dir, briefSpoolKey(input) + ".json")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("orphan brief summaries expire after7days without removing report spools or current completed work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-brief-retention-"));
  try {
    const old = "brief-" + "a".repeat(64),
      current = "brief-" + "b".repeat(64),
      report = "c".repeat(64);
    for (const key of [old, current, report])
      await saveSpool(dir, key, { result });
    const stale = new Date(Date.now() - 8 * 86400000);
    await utimes(path.join(dir, old + ".json"), stale, stale);
    await utimes(path.join(dir, report + ".json"), stale, stale);
    await pruneBriefSpools(dir);
    await assert.rejects(readFile(path.join(dir, old + ".json")));
    assert(await readFile(path.join(dir, current + ".json")));
    assert(await readFile(path.join(dir, report + ".json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("authority stale completion409 discards only the obsolete brief derivative instead of replaying it as fresh", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-brief-stale-"));
  try {
    const host = {
      id: "fixture",
      spool: dir,
      budget: new DailyBudget(path.join(dir, "budget.json"), {
        requests: 2,
        inputTokens: 20000,
        reserveRequests: 0,
        reserveInputTokens: 0,
      }),
      api: async (route: string) => {
        if (route === "brief/claim")
          return {
            lease: {
              id: "oldwindow",
              token: "stale",
              expires_at: "2026-10-21T12:10:00Z",
              report_ids: ["report"],
              input,
            },
          };
        if (route === "brief/complete")
          throw new WorkerError("lease", "worker_brief/complete_409");
        throw Error("must not rewrite obsolete serverstate");
      },
    };
    const reportKey = "d".repeat(64);
    await saveSpool(dir, reportKey, { result: { report_id: "report" } });
    await assert.rejects(
      runBriefOnce(host, {
        persist: (key, value) => saveSpool(dir, key, value),
        analyzer: async () => ({ result, run }),
      }),
      /complete_409/,
    );
    await assert.rejects(
      readFile(path.join(dir, briefSpoolKey(input) + ".json")),
    );
    assert(await readFile(path.join(dir, reportKey + ".json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
