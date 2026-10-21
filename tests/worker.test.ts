import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyError,
  analysisKey,
  sandboxDoctor,
  extractionArgs,
  WorkerError,
} from "../src/worker/adapter.js";
import { saveSpool, spoolKey } from "../src/worker/worker.js";
test("auth and quota interruptions remain distinguishable", () => {
  assert.equal(classifyError("429 usage limit"), "quota");
  assert.equal(classifyError("401 authentication required"), "auth");
});
test(
  "actual OS sandbox denies private files and tool writes",
  { skip: process.env.EW_TEST_CODEX_SANDBOX !== "1" },
  async () => {
    assert.equal((await sandboxDoctor()).passed, true);
  },
);
test("Luna adapter ignores unrestricted user configuration", () => {
  const a = extractionArgs("/private/tmp/ew-test", "schema", "out");
  assert(a.includes("--ignore-user-config"));
  assert(a.includes("--ignore-rules"));
  assert(a.includes("gpt-6-luna"));
  assert(a.includes("features.shell_tool=false"));
  assert(a.includes("features.apps=false"));
  assert(a.includes("features.plugins=false"));
  assert(a.includes("permissions.extractor.network.enabled=false"));
  assert(!a.includes("--dangerously-bypass-approvals-and-sandbox"));
});
test("completed spool survives process recreation and identities differ by input", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-spool-test-"));
  try {
    const a = {
        input: {
          report_id: "a",
          contract_version: "ew-1",
          content_revision: "v1",
        },
      } as any,
      b = {
        input: {
          report_id: "a",
          contract_version: "ew-1",
          content_revision: "v2",
        },
      } as any;
    assert.notEqual(spoolKey(a), spoolKey(b));
    await saveSpool(dir, spoolKey(a), { complete: true });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dir, spoolKey(a) + ".json"), "utf8")),
      { complete: true },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { createServer } from "node:http";
import { RemoteWorker } from "../src/worker/worker.js";
import {
  nextIdleDelay,
  quotaResumeAt,
  storageQuotaMessage,
  workerHeaders,
  invalidRule,
} from "../src/worker/worker.js";
const SITES_WORKER_ORIGIN = "https://example.chatgpt.site";
test("Sites service credential is attached only to the exact trusted origin while retaining worker scope", () => {
  const trusted = workerHeaders(
    SITES_WORKER_ORIGIN,
    "worker-fixture",
    "service-fixture",
    SITES_WORKER_ORIGIN,
  );
  assert.equal(trusted.Authorization, "Bearer worker-fixture");
  assert.equal(trusted["OAI-Sites-Authorization"], "Bearer service-fixture");
  for (const destination of [
    "https://example.com",
    SITES_WORKER_ORIGIN + ".evil.example",
    SITES_WORKER_ORIGIN + "/path",
    "http://example.chatgpt.site",
    "http://127.0.0.1:8787",
  ])
    assert.equal(
      workerHeaders(
        destination,
        "worker-fixture",
        "service-fixture",
        SITES_WORKER_ORIGIN,
      )["OAI-Sites-Authorization"],
      undefined,
    );
  assert.equal(
    workerHeaders(SITES_WORKER_ORIGIN, "worker-fixture")[
      "OAI-Sites-Authorization"
    ],
    undefined,
  );
});
test("worker transport refuses redirects before credentials can reach another endpoint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-redirect-"));
  let destinationCalls = 0;
  const destination = createServer((_req, res) => {
    destinationCalls++;
    res.end("{}");
  });
  await new Promise<void>((resolve) =>
    destination.listen(0, "127.0.0.1", resolve),
  );
  const redirect = createServer((_req, res) => {
    res.writeHead(307, {
      Location: "http://127.0.0.1:" + (destination.address() as any).port,
    });
    res.end();
  });
  await new Promise<void>((resolve) =>
    redirect.listen(0, "127.0.0.1", resolve),
  );
  try {
    const worker = new RemoteWorker({
      base: "http://127.0.0.1:" + (redirect.address() as any).port,
      token: "fixture",
      sitesToken: "private-fixture",
      sitesOrigin: SITES_WORKER_ORIGIN,
      id: "fixture",
      spool: dir,
    });
    await assert.rejects(worker.api("claim", {}), /fetch failed/);
    assert.equal(destinationCalls, 0);
  } finally {
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
    await new Promise<void>((resolve) => destination.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("idle polling stays within one minute for fresh work and resets immediately", () => {
  let delay = 1000;
  const intervals = Array.from(
    { length: 5 },
    () => (delay = nextIdleDelay(delay, 0)),
  );
  assert.deepEqual(intervals, [15000, 30000, 60000, 60000, 60000]);
  assert.equal(nextIdleDelay(delay, 4), 1000);
});
test("storage retry parsing honors provider hints and otherwise waits for next UTC day", () => {
  const now = Date.parse("2026-10-21T12:30:00Z");
  assert.equal(quotaResumeAt("3600", now), now + 3600000);
  assert.equal(
    quotaResumeAt("Wed, 21 Oct 2026 14:00:00 GMT", now),
    Date.parse("2026-10-21T14:00:00Z"),
  );
  assert.equal(quotaResumeAt(null, now), Date.parse("2026-10-22T00:00:00Z"));
  assert(
    storageQuotaMessage(
      "D1_ERROR: Your account has exceeded the daily limit for rows read",
    ),
  );
  assert(!storageQuotaMessage("Unsupported source title"));
});
test("storage circuit persists across restart and prevents every API call without removing completed spool", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-storage-circuit-"));
  let requests = 0;
  let now = Date.parse("2026-10-21T12:00:00Z");
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "storage_quota_paused",
        retry_after_seconds: 3600,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const opts = {
    base: "http://127.0.0.1:" + (server.address() as any).port,
    token: "fixture",
    id: "fixture",
    spool: dir,
    now: () => now,
  };
  try {
    await saveSpool(dir, "completed", { result: { report_id: "retained" } });
    await assert.rejects(
      new RemoteWorker(opts).api("claim", {}),
      /storage_quota_paused/,
    );
    const restarted = new RemoteWorker(opts);
    assert.equal(await restarted.storagePauseUntil(), now + 3600000);
    for (const route of [
      "claim",
      "renew",
      "complete",
      "fail",
      "tombstones",
      "heartbeat",
    ])
      await assert.rejects(restarted.api(route, {}), /storage_quota_paused/);
    assert.equal(requests, 1);
    assert.equal(
      JSON.parse(await readFile(path.join(dir, "completed.json"), "utf8"))
        .result.report_id,
      "retained",
    );
    now += 3600001;
    await assert.rejects(restarted.api("claim", {}), /storage_quota_paused/);
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("idle tombstones and unchanged heartbeats are throttled while state transitions send immediately", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-throttle-"));
  let now = 100000;
  try {
    await fixtureServer([], async (base, calls) => {
      const worker = new RemoteWorker({
        base,
        token: "fixture",
        id: "fixture",
        spool: dir,
        now: () => now,
      });
      await worker.once();
      await worker.once();
      assert.equal(
        calls.filter((c) => c.route.endsWith("/tombstones")).length,
        1,
      );
      assert.equal(
        calls.filter((c) => c.route.endsWith("/heartbeat")).length,
        1,
      );
      await worker.heartbeat("budget");
      assert.equal(
        calls.filter((c) => c.route.endsWith("/heartbeat")).length,
        2,
      );
      now += 60000;
      await worker.once();
      assert.equal(
        calls.filter((c) => c.route.endsWith("/tombstones")).length,
        2,
      );
      assert.equal(
        calls.filter((c) => c.route.endsWith("/heartbeat")).length,
        3,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const lease = (id: string) =>
  ({
    job_id: id,
    attempt_id: "attempt-" + id,
    fence: 2,
    lease_until: new Date(Date.now() + 120000).toISOString(),
    input: {
      report_id: id,
      content_revision: "rev-" + id,
      contract_version: "ew-1",
      input_coverage: "title_only",
      excerpts: [{ id: "e1", text: "public title" }],
    },
  }) as any;
const result = (l: any) =>
  ({
    report_id: l.input.report_id,
    content_revision: l.input.content_revision,
    input_coverage: "title_only",
    original_language: "en",
    relevant: false,
    relevance_reason: "No eligible event",
    summary_en: "No event",
    summary_it: null,
    published_at: null,
    source_updated_at: null,
    claims: [],
    candidate_incident_ids: [],
    uncertainty_flags: [],
    targeted_review: false,
  }) as any;
async function fixtureServer(
  leases: any[],
  run: (base: string, calls: any[]) => Promise<void>,
) {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    const b: any[] = [];
    for await (const d of req) b.push(d);
    const body = JSON.parse(Buffer.concat(b).toString());
    calls.push({ route: req.url, body });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.endsWith("/claim") ? { leases } : { accepted: true },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run("http://127.0.0.1:" + (server.address() as any).port, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const runInfo: any = {
  requested_model: "gpt-6-luna",
  requested_tier: "fast",
  actual_model: null,
  actual_tier: null,
  client_version: "fixture",
  prompt_version: "test",
  schema_version: "ew-1",
  duration_ms: 1,
  usage: null,
  tool_attempts: 0,
};
test("all accepted outputs are durable before first submission hits storage quota", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-batch-storage-"));
  const leases = [lease("a"), lease("b")];
  let inference = 0;
  try {
    const worker = new RemoteWorker({
      base: "http://127.0.0.1:1",
      token: "fixture",
      id: "fixture",
      spool: dir,
      analyzer: async () => {
        inference++;
        return {
          accepted: new Map(
            leases.map((l) => [analysisKey(l.input), result(l)]),
          ),
          invalid: new Map(),
          run: runInfo,
        };
      },
    });
    worker.api = async (route) => {
      if (route === "claim") return { leases };
      if (route === "tombstones") return { report_ids: [] };
      if (route === "complete") {
        for (const l of leases)
          assert.equal(
            JSON.parse(
              await readFile(path.join(dir, spoolKey(l) + ".json"), "utf8"),
            ).result.report_id,
            l.input.report_id,
          );
        throw new WorkerError("storage_quota", "storage_quota_paused");
      }
      return { accepted: true };
    };
    await assert.rejects(worker.once(2), /storage_quota_paused/);
    assert.equal(inference, 1);
    for (const l of leases)
      assert.equal(
        JSON.parse(
          await readFile(path.join(dir, spoolKey(l) + ".json"), "utf8"),
        ).result.report_id,
        l.input.report_id,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("quota wording in successful untrusted lease content cannot activate storage circuit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-quota-wording-"));
  const payload = {
    leases: [
      {
        input: {
          title: "Public report about D1 daily row limit",
          excerpts: [
            {
              id: "e1",
              text: "The account exceeded the daily limit for rows read.",
            },
          ],
        },
      },
    ],
  };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const worker = new RemoteWorker({
      base: "http://127.0.0.1:" + (server.address() as any).port,
      token: "fixture",
      id: "fixture",
      spool: dir,
    });
    assert.deepEqual(await worker.api("claim", {}), payload);
    assert.equal(await worker.storagePauseUntil(), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test("partial invalid batch commits valid peer and retries only invalid report", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-partial-"));
  const a = lease("a"),
    b = lease("b");
  try {
    await fixtureServer([a, b], async (base, calls) => {
      const worker = new RemoteWorker({
        base,
        token: "isolated-test-token",
        id: "fixture",
        spool: dir,
        analyzer: async () => ({
          accepted: new Map([[analysisKey(a.input), result(a)]]),
          invalid: new Map([[analysisKey(b.input), "unsupported_evidence"]]),
          run: runInfo,
        }),
      });
      assert.deepEqual(await worker.once(2), {
        claimed: 2,
        completed: 1,
        failed: 1,
      });
      assert.equal(
        calls.filter((c) => c.route.endsWith("/complete")).length,
        1,
      );
      assert.equal(
        calls.find((c) => c.route.endsWith("/fail")).body.lease.job_id,
        "b",
      );
      const diagnostics = JSON.parse(
        await readFile(path.join(dir, "invalid-diagnostics.json"), "utf8"),
      );
      assert.equal(diagnostics.records[0].report_id, "b");
      assert.equal(diagnostics.records[0].rule, "unsupported_evidence");
      assert.equal(diagnostics.records[0].run.requested_model, "gpt-6-luna");
      assert.deepEqual(Object.keys(diagnostics.records[0]).sort(), [
        "content_revision",
        "job_id",
        "report_id",
        "rule",
        "run",
      ]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("invalid diagnostic rules never retain model or source payloads", () => {
  assert.equal(invalidRule("Error: invalid_event_time"), "invalid_event_time");
  assert.equal(
    invalidRule("schema failure received secret-source-body"),
    "schema_validation",
  );
  assert.equal(
    invalidRule("Error: unsupported_evidence secret-source-body"),
    "schema_validation",
  );
});
test("forged stale spool identity is rejected before current lease completion", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-stale-"));
  const a = lease("a");
  let inference = 0;
  try {
    await saveSpool(dir, spoolKey(a), {
      result: { ...result(a), content_revision: "stale" },
      run: runInfo,
    });
    await fixtureServer([a], async (base, calls) => {
      const worker = new RemoteWorker({
        base,
        token: "isolated-test-token",
        id: "fixture",
        spool: dir,
        analyzer: async () => {
          inference++;
          return {
            accepted: new Map([[analysisKey(a.input), result(a)]]),
            invalid: new Map(),
            run: runInfo,
          };
        },
      });
      await worker.once(1);
      assert.equal(inference, 1);
      assert.equal(
        calls.find((c) => c.route.endsWith("/complete")).body.result
          .content_revision,
        "rev-a",
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("quota interruption releases jobs into tracked failure without deleting work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-quota-"));
  const a = lease("a");
  try {
    await fixtureServer([a], async (base, calls) => {
      const worker = new RemoteWorker({
        base,
        token: "isolated-test-token",
        id: "fixture",
        spool: dir,
        analyzer: async () => {
          throw new (await import("../src/worker/adapter.js")).WorkerError(
            "quota",
            "isolated fixture quota",
          );
        },
      });
      await assert.rejects(worker.once(1), /fixture quota/);
      assert.equal(
        calls.find((c) => c.route.endsWith("/fail")).body.kind,
        "quota",
      );
      assert.equal(
        calls.filter((c) => c.route.endsWith("/complete")).length,
        0,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
import { plist, LABEL } from "../src/worker/supervisor.js";
test("launchd uses scoped environment file and absolute runtime without keep-awake", () => {
  const p = plist("/private/tmp/project");
  assert(p.includes(LABEL));
  assert(p.includes("DOTENV_CONFIG_PATH"));
  assert(p.includes("/private/tmp/project/.runtime/worker.env"));
  assert(
    p.includes("file:///private/tmp/project/node_modules/tsx/dist/loader.mjs"),
  );
  assert(!p.includes("OWNER_TOKEN"));
  assert(!p.includes("COLLECTOR_TOKEN"));
  assert(!p.includes("caffeinate"));
  assert(!p.includes("/bin/sh"));
});
test("remote tombstone removes retained failed-submission result before claiming", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-deletion-"));
  const a = lease("deleted");
  try {
    await saveSpool(dir, spoolKey(a), { result: result(a), run: runInfo });
    const worker = new RemoteWorker({
      base: "http://127.0.0.1:1",
      token: "isolated-test-token",
      id: "fixture",
      spool: dir,
    });
    worker.api = async () => ({ report_ids: ["deleted"] });
    await worker.syncTombstones();
    await assert.rejects(readFile(path.join(dir, spoolKey(a) + ".json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("HTTP200 rejected completion is not acknowledged or counted successful", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-rejected-"));
  try {
    const w = new RemoteWorker({
      base: "http://127.0.0.1:1",
      token: "isolated-test",
      id: "fixture",
      spool: dir,
    });
    w.api = async () => ({ accepted: false, already_completed: true });
    await assert.rejects(
      w.submit(lease("a"), result(lease("a")), runInfo),
      /completion_not_accepted/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
import { DailyBudget } from "../src/worker/budget.js";
test("daily ceilings persist across restart, deduplicate invocation IDs and reset UTC day", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-budget-"));
  let clock = new Date("2026-10-21T12:00:00Z");
  const file = path.join(dir, "budget.json");
  const limits = {
    requests: 3,
    inputTokens: 100000,
    reserveRequests: 1,
    reserveInputTokens: 10000,
  };
  try {
    const a = new DailyBudget(file, limits, () => clock);
    await a.reserve("one", 20000);
    await a.record("one", { input_tokens: 17000, output_tokens: 300 });
    await a.record("one", { input_tokens: 17000, output_tokens: 300 });
    const b = new DailyBudget(file, limits, () => clock);
    assert.equal((await b.summary()).requests, 1);
    assert.equal((await b.summary()).actual_input_tokens, 17000);
    await b.reserve("two", 20000);
    await assert.rejects(b.reserve("three", 20000), /exhausted/);
    assert.equal(await b.available(), false);
    clock = new Date("2026-10-22T00:00:01Z");
    assert.equal((await b.summary()).requests, 0);
    assert.equal(await b.available(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("token budget blocks before invocation and preserves unknown usage reservations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-budget-token-"));
  try {
    const b = new DailyBudget(path.join(dir, "budget.json"), {
      requests: 10,
      inputTokens: 30000,
      reserveRequests: 0,
      reserveInputTokens: 0,
    });
    await b.reserve("unattested", 20000);
    assert.equal((await b.summary()).unattested_invocations, 1);
    assert.equal(await b.available(), false);
    await assert.rejects(b.reserve("next", 20000), /exhausted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
import {
  compactInputs,
  restoreResult,
  WireResult,
  WireBatch,
} from "../src/worker/wire.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { validEventTime } from "../src/shared/contracts.js";
test("Luna output schema requires day precision or an explicit offset for all four time fields", () => {
  const schema: any = zodToJsonSchema(WireBatch, {
    $refStrategy: "none",
    target: "openAi",
  });
  const claim =
    schema.properties.results.items.properties.claims.items.properties;
  const instruction = claim.official_instruction.anyOf[0].properties;
  for (const field of [
    claim.event_start,
    claim.event_end,
    instruction.effective_at,
    instruction.expires_at,
  ]) {
    assert.equal(field.anyOf[0].type, "string");
    assert.equal(field.anyOf[1].type, "null");
    const pattern = new RegExp(field.anyOf[0].pattern);
    assert(pattern.test("2026-11-21"));
    assert(pattern.test("2026-11-21T00:10:00+01:00"));
    assert(pattern.test("2026-11-21T00:10:00Z"));
    assert(!pattern.test("2026-11-21T00:10:00"));
    assert(!pattern.test("21/11/2026 00h10"));
    assert(!pattern.test("2026-11-21T24:10:00Z"));
  }
  assert.equal(validEventTime("2026-02-30"), false);
  assert.equal(validEventTime("2026-11-21"), true);
});
test("compact wire preserves full evidence and correction tail while excluding operational metadata", () => {
  const r = {
    ...lease("id").input,
    source_id: "internal-source",
    native_id: "private-native",
    canonical_url: "https://example.invalid/token-placeholder",
    title: "Heading",
    published_at: "2026-10-21T10:00:00Z",
    source_updated_at: null,
    first_observed_at: "not-for-model",
    ingested_at: "not-for-model",
    original_language: "en",
    excerpts: [
      {
        id: "e1",
        text: "Heading\nFull body. Correction in final paragraph: Sevilla, not Madrid.",
      },
    ],
  };
  const wire = compactInputs([r]);
  assert.equal(wire.reports[0].excerpts[0].text, r.excerpts[0].text);
  const text = JSON.stringify(wire);
  assert(!text.includes("private-native"));
  assert(!text.includes("internal-source"));
  assert(!text.includes("token-placeholder"));
  assert(!text.includes("content_revision"));
  assert(!("title" in wire.reports[0]));
});
test("wire index output cannot change trusted publication/identity metadata", () => {
  const input = {
    ...lease("host-bound").input,
    published_at: "2026-10-21T10:00:00Z",
    source_updated_at: null,
  };
  const parsed = WireResult.parse({
    index: 0,
    language: "en",
    relevant: false,
    reason: "No event stated",
    summary: "No eligible event stated.",
    italian: null,
    claims: [],
    uncertainty: [],
    review: false,
  });
  const r = restoreResult(parsed, input);
  assert.equal(r.report_id, "host-bound");
  assert.equal(r.content_revision, "rev-host-bound");
  assert.equal(r.published_at, input.published_at);
  assert.throws(() => WireResult.parse({ ...parsed, report_id: "forged" }));
});

test("budget pause still propagates deletions and never claims more work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-budget-deletion-"));
  const a = lease("deleted-during-budget");
  try {
    await saveSpool(dir, spoolKey(a), { result: result(a), run: runInfo });
    const w = new RemoteWorker({
      base: "http://127.0.0.1:1",
      token: "isolated-test",
      id: "fixture",
      spool: dir,
    });
    w.budget = new DailyBudget(path.join(dir, "budget.json"), {
      requests: 0,
      inputTokens: 0,
      reserveRequests: 0,
      reserveInputTokens: 0,
    });
    const routes: string[] = [];
    w.api = async (route: string) => {
      routes.push(route);
      if (route === "tombstones")
        return { report_ids: ["deleted-during-budget"] };
      if (route === "heartbeat") return { ok: true };
      throw Error("must not claim");
    };
    await assert.rejects(w.once(), /daily_worker_budget_exhausted/);
    assert(!routes.includes("claim"));
    await assert.rejects(readFile(path.join(dir, spoolKey(a) + ".json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two revisions of one report remain separate analysis identities in the same batch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-revisions-"));
  const first = lease("same-report"),
    second = {
      ...lease("second-job"),
      input: {
        ...lease("same-report").input,
        content_revision: "new-revision",
      },
    };
  try {
    await fixtureServer([first, second], async (base, calls) => {
      const worker = new RemoteWorker({
        base,
        token: "isolated-test",
        id: "fixture",
        spool: dir,
        analyzer: async () => ({
          accepted: new Map([
            [analysisKey(first.input), result(first)],
            [analysisKey(second.input), result(second)],
          ]),
          invalid: new Map(),
          run: runInfo,
        }),
      });
      assert.deepEqual(await worker.once(2), {
        claimed: 2,
        completed: 2,
        failed: 0,
      });
      assert.deepEqual(
        calls
          .filter((c) => c.route.endsWith("/complete"))
          .map((c) => c.body.result.content_revision)
          .sort(),
        ["new-revision", "rev-same-report"],
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
