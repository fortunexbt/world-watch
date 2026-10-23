import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyze, analysisKey, WorkerError } from "../src/worker/adapter.js";
import { ProviderBudget } from "../src/worker/budget.js";
import {
  chatBackend,
  chatProviders,
  detectLocal,
  parseContent,
  retryAfterMs,
  type Provider,
} from "../src/worker/chat.js";
import { headlineInput, triageHeadlines } from "../src/worker/triage.js";
import type { JobInput } from "../src/shared/contracts.js";

const quiet = () => {};
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
/** Answers only the loopback URLs listed; everything else is refused like a closed port. */
function loopback(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    if (!(url in routes)) throw new TypeError("fetch failed");
    return json(routes[url]);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const lmStudio = {
  "http://127.0.0.1:1234/v1/models": {
    object: "list",
    data: [
      { id: "qwen3-14b", object: "model", owned_by: "organization_owner" },
      { id: "text-embedding-nomic-embed-text-v1.5", object: "model" },
    ],
  },
  "http://127.0.0.1:1234/api/v0/models": {
    object: "list",
    data: [
      { id: "qwen3-14b", type: "llm", state: "loaded" },
      {
        id: "text-embedding-nomic-embed-text-v1.5",
        type: "embeddings",
        state: "loaded",
      },
    ],
  },
};
const llamaServer = {
  "http://127.0.0.1:9931/v1/models": {
    models: [{ name: "Qwen3-14B-Q4_K_M.gguf", model: "Qwen3-14B-Q4_K_M.gguf" }],
    object: "list",
    data: [
      {
        id: "Qwen3-14B-Q4_K_M.gguf",
        object: "model",
        owned_by: "llamacpp",
        meta: { n_params: 14768307200 },
      },
    ],
  },
};
const ollama = {
  "http://127.0.0.1:11434/v1/models": {
    object: "list",
    data: [
      { id: "qwen3:14b", object: "model", owned_by: "library" },
      { id: "llama3.2:3b", object: "model", owned_by: "library" },
    ],
  },
  "http://127.0.0.1:11434/api/ps": {
    models: [{ name: "qwen3:14b", model: "qwen3:14b", size: 9000000000 }],
  },
};

test("detection reads each server's own model shape", async () => {
  for (const [routes, id, model, structured] of [
    [lmStudio, "local-lm-studio", "qwen3-14b", "json_schema"],
    [llamaServer, "local-llama-server", "Qwen3-14B-Q4_K_M.gguf", "json_schema"],
    [ollama, "local-ollama", "qwen3:14b", "json_object"],
  ] as const) {
    const found = await detectLocal(undefined, {
      fetch: loopback(routes).f,
      log: quiet,
    });
    assert.equal(found?.id, id);
    assert.equal(found?.model, model);
    assert.equal(found?.structured_output, structured);
    assert.match(found!.base_url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  }
});

test("detection probes loopback only and reports when nothing answers", async () => {
  const { f, calls } = loopback({});
  const events: any[] = [];
  assert.equal(
    await detectLocal(undefined, { fetch: f, log: (e) => events.push(e) }),
    null,
  );
  assert(calls.length >= 7);
  assert(calls.every((url) => url.startsWith("http://127.0.0.1:")));
  assert.deepEqual(events, []);
  await assert.rejects(
    chatProviders("/nonexistent", {}, { fetch: f, log: quiet }),
    (e: any) =>
      e instanceof WorkerError &&
      e.kind === "model" &&
      e.message === "no_local_inference_server_detected",
  );
});

test("two answering servers resolve in documented order and the choice is logged", async () => {
  const events: any[] = [];
  const found = await detectLocal(undefined, {
    fetch: loopback({ ...ollama, ...llamaServer }).f,
    log: (e) => events.push(e),
  });
  assert.equal(found?.id, "local-llama-server");
  assert.deepEqual(events, [
    {
      local_inference: "detected",
      server: "llama.cpp llama-server",
      endpoint: "http://127.0.0.1:9931/v1",
      model: "Qwen3-14B-Q4_K_M.gguf",
    },
  ]);
});

test("a configured model name wins and ambiguous servers are skipped, never guessed", async () => {
  const mlx = {
    "http://127.0.0.1:8080/v1/models": {
      object: "list",
      data: [
        { id: "Qwen/Qwen3-8B-MLX-4bit", object: "model", created: 1 },
        { id: "Qwen/Qwen3-14B-MLX-4bit", object: "model", created: 1 },
      ],
    },
  };
  const events: any[] = [];
  const skipped = await detectLocal(undefined, {
    fetch: loopback(mlx).f,
    log: (e) => events.push(e),
  });
  assert.equal(skipped, null);
  assert.equal(events[0].reason, "several_models_set_EW_LOCAL_MODEL");
  const chosen = await detectLocal("Qwen/Qwen3-14B-MLX-4bit", {
    fetch: loopback({ ...mlx, ...llamaServer }).f,
    log: quiet,
  });
  assert.equal(chosen?.id, "local-mlx-lm-or-localai");
  assert.equal(chosen?.model, "Qwen/Qwen3-14B-MLX-4bit");
  assert.equal(chosen?.structured_output, "none");
});

test("explicit configuration wins over detection and keys come only from the environment", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-config-"));
  try {
    const file = path.join(dir, "inference.json");
    await writeFile(
      file,
      JSON.stringify({
        providers: [
          {
            id: "groq",
            base_url: "https://api.groq.com/openai/v1",
            model: "openai/gpt-oss-120b",
            api_key_env: "GROQ_API_KEY",
            structured_output: "json_schema",
            limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
          },
        ],
      }),
    );
    const { f, calls } = loopback(llamaServer);
    await assert.rejects(
      chatProviders(dir, { EW_INFERENCE_CONFIG: file }, { fetch: f }),
      (e: any) => e.kind === "auth" && e.message === "missing_GROQ_API_KEY",
    );
    const [p] = await chatProviders(
      dir,
      { EW_INFERENCE_CONFIG: file, GROQ_API_KEY: "test-key" },
      { fetch: f },
    );
    assert.equal(p.id, "groq");
    assert.equal(p.key, "test-key");
    assert.deepEqual(calls, []);
    await writeFile(
      file,
      JSON.stringify({
        providers: [
          {
            id: "lan",
            base_url: "http://192.168.1.20:8080/v1",
            model: "m",
            structured_output: "none",
          },
        ],
      }),
    );
    await assert.rejects(
      chatProviders(dir, { EW_INFERENCE_CONFIG: file }),
      /chat_endpoint_requires_https_or_loopback/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function input(text: string, n = 0): JobInput {
  return {
    source_id: "isolated-test",
    native_id: String(n),
    canonical_url: "https://example.invalid/" + n,
    title: "Report " + n,
    original_language: "en",
    published_at: null,
    source_updated_at: null,
    input_coverage: "permitted_excerpt",
    excerpts: [{ id: "e1", text }],
    report_id: "report-" + n,
    content_revision: "rev-" + n,
    contract_version: "ew-1",
    first_observed_at: "2026-10-23T00:00:00Z",
    ingested_at: "2026-10-23T00:00:00Z",
  };
}
function wire(index: number, update: Record<string, unknown> = {}) {
  return {
    index,
    language: "en",
    relevant: true,
    reason: "Planned public gathering.",
    summary: "A peaceful march is planned in Rome.",
    italian: null,
    claims: [
      {
        id: "c1",
        activity: "planned_demonstration",
        summary: "A peaceful march is planned in Rome.",
        evidence_ids: ["e1"],
        places: [
          {
            name: "Rome",
            country: "IT",
            admin: null,
            evidence_ids: ["e1"],
            uncertainty: null,
          },
        ],
        event_start: "2026-10-25",
        event_end: null,
        timezone: null,
        temporal_status: "planned",
        time_uncertainty: null,
        impacts: [],
        violence_mentioned: "no",
        impact: "unknown",
        impact_uncertainty: null,
        official_instruction: null,
        relationships: [],
        ...update,
      },
    ],
    uncertainty: [],
    review: false,
  };
}
/** A streamed completion whose JSON arrives split across events, as servers send it. */
function completion(results: unknown[], model = "served-model") {
  const content = JSON.stringify({ results }),
    mid = Math.floor(content.length / 2),
    chunk = (rest: object) => ({
      id: "cmpl-1",
      object: "chat.completion.chunk",
      model,
      ...rest,
    });
  const events = [
    chunk({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: content.slice(0, mid) },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      choices: [
        {
          index: 0,
          delta: { content: content.slice(mid) },
          finish_reason: null,
        },
      ],
    }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({
      choices: [],
      usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
    }),
  ];
  return new Response(
    events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const noon = () => Date.parse("2026-10-23T12:00:00Z");
async function providers(
  dir: string,
  list: Partial<Provider>[],
  now = noon,
): Promise<Provider[]> {
  return list.map((p, i) => {
    const id = p.id ?? "p" + i;
    return {
      id,
      base_url: "https://provider-" + id + ".example/v1",
      model: "model-" + id,
      structured_output: "json_schema",
      max_output_tokens: 2000,
      limits: {},
      request: {},
      ...p,
      budget: new ProviderBudget(
        path.join(dir, "provider-" + id + ".json"),
        p.limits ?? {},
        now,
      ),
    } as Provider;
  });
}

test("chat backend requests the wire schema and records requested and actual identity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-"));
  try {
    const sent: any[] = [];
    const backend = chatBackend(
      await providers(dir, [{ id: "groq", key: "secret-test-key" }]),
      {
        fetch: (async (url: string, init: RequestInit) => {
          sent.push({ url, init, body: JSON.parse(String(init.body)) });
          return completion([wire(0)], "model-groq-2026-10");
        }) as any,
        log: quiet,
      },
    );
    const a = input(
      "A peaceful march is planned in Rome, Italy on 25 October 2026.",
    );
    const r = await analyze([a], { backend });
    assert.equal(r.accepted.size, 1);
    const run = r.runs.get(analysisKey(a))!;
    assert.equal(run.provider, "groq");
    assert.equal(run.requested_model, "model-groq");
    assert.equal(run.actual_model, "model-groq-2026-10");
    assert.equal(run.endpoint, "https://provider-groq.example/v1");
    assert.equal(run.tool_attempts, 0);
    assert.equal(run.switches, undefined);
    assert.equal(
      sent[0].url,
      "https://provider-groq.example/v1/chat/completions",
    );
    assert.equal(sent[0].init.headers.Authorization, "Bearer secret-test-key");
    assert.equal(sent[0].init.redirect, "error");
    const format = sent[0].body.response_format;
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assert.deepEqual(
      format.json_schema.schema.properties.results.items.properties.index.enum,
      [0],
    );
    assert.match(sent[0].body.messages[0].content, /"planned_demonstration"/);
    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(run.usage, {
      prompt_tokens: 900,
      completion_tokens: 300,
      total_tokens: 1200,
    });
    assert(!JSON.stringify(sent[0].body).includes("secret-test-key"));
    assert(!JSON.stringify(run).includes("secret-test-key"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host validation stays authoritative over chat output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-"));
  try {
    const backend = chatBackend(await providers(dir, [{}]), {
      fetch: (async () =>
        completion([
          wire(0, { impact: "severe", impacts: ["disruption"] }),
          wire(1, { evidence_ids: ["invented"] }),
          wire(2),
        ])) as any,
      log: quiet,
    });
    const inputs = [
      input(
        "A peaceful march is planned in Rome, Italy on 25 October 2026.",
        0,
      ),
      input(
        "A peaceful march is planned in Rome, Italy on 25 October 2026.",
        1,
      ),
      input(
        "A peaceful march is planned in Rome, Italy on 25 October 2026.",
        2,
      ),
    ];
    const r = await analyze(inputs, { backend });
    assert.equal(r.accepted.size, 1);
    assert.match(
      r.invalid.get(analysisKey(inputs[0]))!,
      /unsupported_escalation/,
    );
    assert.match(
      r.invalid.get(analysisKey(inputs[1]))!,
      /invalid_enum_value|unsupported_evidence|invalid/,
    );
    assert(r.accepted.has(analysisKey(inputs[2])));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("instruction mode embeds the schema and accepts fenced or reasoning-prefixed JSON", async () => {
  assert.deepEqual(
    parseContent('<think>notes</think>\n```json\n{"results":[]}\n```'),
    { results: [] },
  );
  assert.throws(() => parseContent("Sure! Here it is."), /invalid_json_output/);
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-"));
  try {
    let body: any;
    const backend = chatBackend(
      await providers(dir, [{ structured_output: "none" }]),
      {
        fetch: (async (_: string, init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return completion([wire(0)]);
        }) as any,
        log: quiet,
      },
    );
    await analyze([input("A peaceful march is planned in Rome, Italy.")], {
      backend,
    });
    assert.equal(body.response_format, undefined);
    assert.match(body.messages[0].content, /JSON Schema/);
    assert.match(body.messages[0].content, /"results"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("429 waits for Retry-After on the same provider", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-"));
  try {
    let clock = Date.parse("2026-10-23T12:00:00Z");
    const slept: number[] = [];
    let calls = 0;
    const backend = chatBackend(
      await providers(dir, [{ id: "groq" }], () => clock),
      {
        fetch: (async () =>
          ++calls === 1
            ? json(
                { error: "rate_limited" },
                { status: 429, headers: { "retry-after": "7" } },
              )
            : completion([wire(0)])) as any,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
        now: () => clock,
        log: quiet,
      },
    );
    const a = input("A peaceful march is planned in Rome, Italy.");
    const r = await analyze([a], { backend });
    assert.equal(r.accepted.size, 1);
    assert.deepEqual(slept, [7000]);
    assert.equal(calls, 2);
    const ledger = JSON.parse(
      await readFile(path.join(dir, "provider-groq.json"), "utf8"),
    );
    assert.equal(ledger.blocked_until, Date.parse("2026-10-23T12:00:07Z"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exhaustion moves down the explicit list and every switch is recorded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-"));
  try {
    const hosts: string[] = [];
    const list = await providers(dir, [
      { id: "first" },
      { id: "spent", limits: { rpd: 1 } },
      { id: "last" },
    ]);
    await list[1].budget.reserve("earlier-today", 10);
    const backend = chatBackend(list, {
      fetch: (async (url: string) => {
        hosts.push(new URL(url).hostname);
        return url.includes("first")
          ? json({}, { status: 429, headers: { "retry-after": "3600" } })
          : completion([wire(0)], "served-last");
      }) as any,
      now: noon,
      log: quiet,
    });
    const a = input("A peaceful march is planned in Rome, Italy.");
    const run = (await analyze([a], { backend })).runs.get(analysisKey(a))!;
    assert.deepEqual(hosts, [
      "provider-first.example",
      "provider-last.example",
    ]);
    assert.equal(run.provider, "last");
    assert.equal(run.actual_model, "served-last");
    assert.deepEqual(run.switches, [
      {
        provider: "first",
        model: "model-first",
        reason: "provider_429_retry_after_3600s",
      },
      {
        provider: "spent",
        model: "model-spent",
        reason: "provider_daily_limit",
      },
    ]);
    await assert.rejects(
      chatBackend(list.slice(0, 2), {
        fetch: (async () =>
          json({}, { status: 429, headers: { "retry-after": "3600" } })) as any,
        now: noon,
        log: quiet,
      })({
        invocation_id: "x",
        instructions: "",
        payload: {},
        schema: {},
        timeout: 1000,
        tier: "fast",
        effort: "low",
      }),
      (e: any) =>
        e.kind === "quota" &&
        /^all_providers_exhausted:first=provider_paused_\d+s,spent=provider_daily_limit$/.test(
          e.message,
        ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a streamed tool call is an isolation failure, never a result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-"));
  try {
    const call = {
      id: "cmpl-1",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "t1",
                type: "function",
                function: { name: "shell", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const backend = chatBackend(await providers(dir, [{}]), {
      fetch: (async () =>
        new Response(
          "data: " + JSON.stringify(call) + "\n\ndata: [DONE]\n\n",
        )) as any,
      log: quiet,
    });
    await assert.rejects(
      analyze([input("A peaceful march is planned in Rome, Italy.")], {
        backend,
      }),
      (e: any) =>
        e.kind === "isolation" && /^unexpected_tool_attempt:/.test(e.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configuration faults never fall back to another provider", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-chat-"));
  try {
    const hosts: string[] = [];
    const backend = chatBackend(
      await providers(dir, [{ id: "a" }, { id: "b" }]),
      {
        fetch: (async (url: string) => {
          hosts.push(new URL(url).hostname);
          return json({ error: "invalid key" }, { status: 401 });
        }) as any,
        log: quiet,
      },
    );
    await assert.rejects(
      analyze([input("A peaceful march is planned in Rome, Italy.")], {
        backend,
      }),
      (e: any) => e.kind === "auth",
    );
    assert.deepEqual(hosts, ["provider-a.example"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider budget paces per minute and stops for the UTC day", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-rate-"));
  try {
    let clock = Date.parse("2026-10-23T23:57:00Z");
    const b = new ProviderBudget(
      path.join(dir, "p.json"),
      { rpm: 2, tpm: 1000, rpd: 3, tpd: 5000 },
      () => clock,
    );
    assert.equal(await b.reserve("a", 400), 0);
    assert.equal(await b.reserve("b", 400), 0);
    assert.equal(await b.reserve("c", 100), 60000);
    clock += 30000;
    await b.record("a", 100);
    assert.equal(await b.reserve("c", 400), 30000);
    clock += 30001;
    assert.equal(await b.reserve("c", 400), 0);
    await assert.rejects(b.reserve("d", 10), /provider_daily_limit/);
    await assert.rejects(
      b.reserve("e", 2000),
      /provider_daily_limit|request_exceeds_provider_tpm/,
    );
    clock = Date.parse("2026-10-24T00:05:00Z");
    assert.equal(await b.reserve("d", 10), 0);
    await assert.rejects(
      b.reserve("big", 1001),
      /request_exceeds_provider_tpm/,
    );
    assert.throws(
      () => new ProviderBudget("x", { rpm: 0 }),
      /invalid_provider_limit/,
    );
    assert.equal(retryAfterMs("2.5", 0), 2500);
    assert.equal(retryAfterMs(new Date(60000).toUTCString(), 0), 60000);
    assert.equal(retryAfterMs("soon", 0), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headline triage sends titles only and returns validated candidates", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-triage-"));
  try {
    const record = {
      id: "gdelt-1",
      title: "Thousands march peacefully in Rome against budget cuts",
      url: "https://publisher.example/article-1",
      language: "en",
      seen_at: "2026-10-23T08:15:00Z",
    };
    const job = headlineInput(record);
    assert.equal(job.input_coverage, "title_only");
    assert.deepEqual(job.excerpts, [{ id: "title", text: record.title }]);
    assert.equal(job.published_at, null);
    let payload: any;
    const backend = chatBackend(await providers(dir, [{ id: "local" }]), {
      fetch: (async (_: string, init: RequestInit) => {
        payload = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
        const ok = wire(0, {
          evidence_ids: ["title"],
          activity: "ongoing_demonstration",
          temporal_status: "current",
          event_start: null,
          places: [
            {
              name: "Rome",
              country: "IT",
              admin: null,
              evidence_ids: ["title"],
              uncertainty: null,
            },
          ],
        });
        return completion([
          ok,
          wire(1, {
            evidence_ids: ["title"],
            places: [],
            impact: "critical",
            impacts: ["march"],
          }),
        ]);
      }) as any,
      log: quiet,
    });
    const out = await triageHeadlines(
      [record, { ...record, id: "gdelt-2", title: "Second headline" }],
      { backend },
    );
    assert.deepEqual(payload.reports[0].excerpts, [
      { id: "title", text: record.title },
    ]);
    assert(!JSON.stringify(payload).includes("publisher.example"));
    assert.equal(out[0].status, "accepted");
    if (out[0].status === "accepted") {
      assert.equal(out[0].relevant, true);
      assert.deepEqual(out[0].categories, ["ongoing_demonstration"]);
      assert.deepEqual(out[0].places, [
        { name: "Rome", country: "IT", admin: null, uncertainty: null },
      ]);
      assert.equal(out[0].run.provider, "local");
    }
    assert.deepEqual(
      { id: out[1].id, status: out[1].status, rule: (out[1] as any).rule },
      { id: "gdelt-2", status: "rejected", rule: "unsupported_escalation" },
    );
    assert.throws(() => headlineInput({ ...record, url: "not a url" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
