import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProviderBudget } from "./budget.js";
import {
  WorkerError,
  codexBackend,
  type Backend,
  type BackendRun,
} from "./adapter.js";

const Limit = z.number().int().positive().optional();
export const ProviderConfig = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    base_url: z
      .string()
      .url()
      .refine(
        (url) =>
          /^https:\/\//.test(url) ||
          /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url),
        "chat_endpoint_requires_https_or_loopback",
      ),
    model: z.string().min(1),
    /** Name of the environment variable holding the key; keys never appear in configuration. */
    api_key_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    structured_output: z.enum(["json_schema", "json_object", "none"]),
    max_output_tokens: z.number().int().positive().default(8192),
    limits: z
      .object({ rpm: Limit, rpd: Limit, tpm: Limit, tpd: Limit })
      .strict()
      .default({}),
    /** Provider-specific request fields such as reasoning settings; they override defaults. */
    request: z.record(z.unknown()).default({}),
  })
  .strict();
export const InferenceConfig = z
  .object({ providers: z.array(ProviderConfig).min(1) })
  .strict()
  .refine(
    (c) => new Set(c.providers.map((p) => p.id)).size === c.providers.length,
    "duplicate_provider_id",
  );
export type ProviderSettings = z.infer<typeof ProviderConfig>;
export type Provider = ProviderSettings & {
  key?: string;
  budget: ProviderBudget;
};
type Deps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
};
const log = (event: Record<string, unknown>) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), ...event }));
/** Waits longer than this leave the provider for the next configured one. */
const MAX_WAIT_MS = 60000;
const MAX_RATE_RETRIES = 3;

/**
 * Default loopback ports, probed in this order. Sources are cited in
 * docs/inference-providers.md. Port 8080 is shared, so it is labelled with both servers.
 */
export const LOCAL_SERVERS: {
  id: string;
  server: string;
  port: number;
  structured_output: ProviderSettings["structured_output"];
  loaded?: (body: any, ids: string[]) => string[];
  loadedPath?: string;
}[] = [
  {
    id: "llama-server",
    server: "llama.cpp llama-server",
    port: 9931,
    structured_output: "json_schema",
    loaded: (body, ids) =>
      body.data?.some((m: any) => m.status)
        ? body.data
            .filter((m: any) => m.status?.value === "loaded")
            .map((m: any) => m.id)
        : ids,
  },
  {
    id: "mlx-lm-or-localai",
    server: "mlx_lm.server or LocalAI",
    port: 8080,
    structured_output: "none",
  },
  {
    id: "lm-studio",
    server: "LM Studio",
    port: 1234,
    structured_output: "json_schema",
    loadedPath: "/api/v0/models",
    loaded: (body) =>
      (body.data ?? [])
        .filter(
          (m: any) =>
            m.state === "loaded" && (m.type === "llm" || m.type === "vlm"),
        )
        .map((m: any) => m.id),
  },
  {
    id: "ollama",
    server: "Ollama",
    port: 11434,
    structured_output: "json_object",
    loadedPath: "/api/ps",
    loaded: (body) => (body.models ?? []).map((m: any) => m.model ?? m.name),
  },
  { id: "vllm", server: "vLLM", port: 8000, structured_output: "json_schema" },
  { id: "jan", server: "Jan", port: 1337, structured_output: "none" },
  {
    id: "text-generation-webui",
    server: "text-generation-webui",
    port: 5000,
    structured_output: "none",
  },
];

async function getJson(f: typeof fetch, url: string) {
  const res = await f(url, {
    redirect: "error",
    signal: AbortSignal.timeout(800),
  });
  if (!res.ok) throw Error("http_" + res.status);
  return res.json();
}

/**
 * Probes the known local servers on loopback only and returns the first, in
 * LOCAL_SERVERS order, that serves one unambiguous model.
 */
export async function detectLocal(
  preferredModel: string | undefined,
  deps: Deps = {},
): Promise<ProviderSettings | null> {
  const f = deps.fetch ?? fetch,
    say = deps.log ?? log;
  const probes = await Promise.all(
    LOCAL_SERVERS.map(async (s) => {
      const origin = `http://127.0.0.1:${s.port}`;
      let ids: string[];
      try {
        const body = await getJson(f, origin + "/v1/models");
        ids = (body.data ?? []).map((m: any) => m.id).filter(Boolean);
        if (preferredModel)
          return ids.includes(preferredModel)
            ? { s, origin, model: preferredModel }
            : { s, origin, skip: "preferred_model_not_listed" };
        const loaded = s.loaded
          ? s.loaded(
              s.loadedPath ? await getJson(f, origin + s.loadedPath) : body,
              ids,
            )
          : ids;
        return loaded.length === 1
          ? { s, origin, model: loaded[0] }
          : {
              s,
              origin,
              skip: loaded.length
                ? "several_models_set_EW_LOCAL_MODEL"
                : "no_loaded_model",
            };
      } catch {
        return null;
      }
    }),
  );
  for (const probe of probes) {
    if (!probe) continue;
    if (!probe.model) {
      say({
        local_inference: "skipped",
        server: probe.s.server,
        endpoint: probe.origin + "/v1",
        reason: probe.skip,
      });
      continue;
    }
    say({
      local_inference: "detected",
      server: probe.s.server,
      endpoint: probe.origin + "/v1",
      model: probe.model,
    });
    return {
      id: "local-" + probe.s.id,
      base_url: probe.origin + "/v1",
      model: probe.model,
      structured_output: probe.s.structured_output,
      max_output_tokens: 8192,
      limits: {},
      request: {},
    };
  }
  return null;
}

/** Explicit configuration wins; otherwise one detected loopback server is used. */
export async function chatProviders(
  spool: string,
  env: Record<string, string | undefined> = process.env,
  deps: Deps = {},
): Promise<Provider[]> {
  let settings: ProviderSettings[];
  if (env.EW_INFERENCE_CONFIG) {
    settings = InferenceConfig.parse(
      JSON.parse(await readFile(env.EW_INFERENCE_CONFIG, "utf8")),
    ).providers;
  } else {
    const local = await detectLocal(env.EW_LOCAL_MODEL || undefined, deps);
    if (!local)
      throw new WorkerError("model", "no_local_inference_server_detected");
    settings = [local];
  }
  return settings.map((p) => {
    const key = p.api_key_env ? env[p.api_key_env] : undefined;
    if (p.api_key_env && !key)
      throw new WorkerError("auth", "missing_" + p.api_key_env);
    return {
      ...p,
      key,
      budget: new ProviderBudget(
        path.join(spool, `provider-${p.id}.json`),
        p.limits,
        deps.now,
      ),
    };
  });
}

export function retryAfterMs(value: string | null, now: number) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim()))
    return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function parseContent(content: string) {
  const text = content
    .replace(/^\s*<think>[\s\S]*?<\/think>/, "")
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkerError("invalid", "invalid_json_output");
  }
}

/** Folds a chat-completions event stream into the fields the run needs. */
async function readStream(res: Response) {
  const out = {
    content: "",
    model: null as string | null,
    service_tier: null as string | null,
    finish_reason: null as string | null,
    usage: null as any,
    tool_calls: [] as unknown[],
  };
  let buffer = "";
  for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const data = line.match(/^data:\s*(.*)$/)?.[1]?.trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.error)
        throw new WorkerError(
          "transport",
          "chat_stream_error:" + JSON.stringify(event.error).slice(0, 600),
        );
      if (typeof event.model === "string") out.model = event.model;
      if (typeof event.service_tier === "string")
        out.service_tier = event.service_tier;
      if (event.usage) out.usage = event.usage;
      const choice = event.choices?.[0];
      out.content += choice?.delta?.content ?? "";
      out.tool_calls.push(...(choice?.delta?.tool_calls ?? []));
      if (choice?.finish_reason) out.finish_reason = choice.finish_reason;
    }
  }
  return out;
}

function httpKind(status: number) {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 404 || status === 422) return "model";
  return "transport";
}

async function complete(
  p: Provider,
  request: Parameters<Backend>[0],
  deps: Required<Deps>,
): Promise<{ output: unknown; run: BackendRun }> {
  // Constrained decoding alone hides the allowed values from the model, which
  // then completes an unlisted word into whichever enum shares its prefix.
  const system =
    request.instructions +
    "\nReturn exactly one JSON object conforming to this JSON Schema, with no other text:\n" +
    JSON.stringify(request.schema);
  const body = {
    model: p.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(request.payload) },
    ],
    temperature: 0,
    max_tokens: p.max_output_tokens,
    // Streaming keeps a slow local generation alive past fetch's header timeout.
    stream: true,
    stream_options: { include_usage: true },
    ...(p.structured_output === "json_schema"
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "analysis_batch",
              strict: true,
              schema: request.schema,
            },
          },
        }
      : p.structured_output === "json_object"
        ? { response_format: { type: "json_object" } }
        : {}),
    ...p.request,
  };
  const serialized = JSON.stringify(body),
    estimate =
      Math.ceil(Buffer.byteLength(serialized) / 3) + p.max_output_tokens;
  for (let attempt = 0; ;) {
    const id = `${request.invocation_id}:${p.id}:${attempt}`;
    let wait: number;
    try {
      wait = await p.budget.reserve(id, estimate);
    } catch (e) {
      throw new WorkerError("quota", (e as Error).message);
    }
    if (wait > MAX_WAIT_MS)
      throw new WorkerError(
        "quota",
        `provider_paused_${Math.ceil(wait / 1000)}s`,
      );
    if (wait) {
      await deps.sleep(wait);
      continue;
    }
    let res: Response;
    try {
      res = await deps.fetch(
        p.base_url.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(p.key ? { Authorization: "Bearer " + p.key } : {}),
          },
          redirect: "error",
          body: serialized,
          signal: AbortSignal.timeout(request.timeout),
        },
      );
    } catch (e) {
      // A timed-out request may still have been served, so it stays charged at the estimate.
      if ((e as Error).name === "TimeoutError")
        throw new WorkerError("transport", "chat_timeout");
      await p.budget.record(id, 0);
      throw new WorkerError(
        "transport",
        "chat_unreachable:" + String((e as any).cause?.code ?? e),
      );
    }
    if (res.status === 429) {
      await p.budget.record(id, 0);
      const retry =
        retryAfterMs(res.headers.get("retry-after"), deps.now()) ??
        1000 * 2 ** attempt;
      await p.budget.block(deps.now() + retry);
      if (++attempt > MAX_RATE_RETRIES || retry > MAX_WAIT_MS)
        throw new WorkerError(
          "quota",
          `provider_429_retry_after_${Math.ceil(retry / 1000)}s`,
        );
      continue;
    }
    if (!res.ok) {
      await p.budget.record(id, 0);
      throw new WorkerError(
        httpKind(res.status),
        `chat_${res.status}: ${(await res.text()).slice(0, 600)}`,
      );
    }
    let json: Awaited<ReturnType<typeof readStream>>;
    try {
      json = await readStream(res);
    } catch (e) {
      if (e instanceof WorkerError) throw e;
      throw new WorkerError(
        (e as Error).name === "TimeoutError" ? "transport" : "invalid",
        (e as Error).name === "TimeoutError"
          ? "chat_timeout"
          : "chat_stream_invalid",
      );
    }
    const usage = json.usage;
    if (Number.isSafeInteger(usage?.total_tokens))
      await p.budget.record(id, usage.total_tokens);
    if (request.budget)
      await request.budget.record(request.invocation_id, {
        input_tokens: usage?.prompt_tokens,
        output_tokens: usage?.completion_tokens,
      });
    if (json.tool_calls.length)
      throw new WorkerError(
        "isolation",
        "unexpected_tool_attempt:" +
          JSON.stringify(json.tool_calls).slice(0, 1200),
      );
    if (json.finish_reason === "length")
      throw new WorkerError("invalid", "output_truncated");
    return {
      output: parseContent(json.content),
      run: {
        requested_model: p.model,
        requested_tier:
          typeof p.request.service_tier === "string"
            ? p.request.service_tier
            : "default",
        actual_model: json.model,
        actual_tier: json.service_tier,
        client_version: "chat-completions",
        usage,
        tool_attempts: 0,
        provider: p.id,
        endpoint: p.base_url,
      },
    };
  }
}

/**
 * Tries providers in their configured order. Only exhaustion (daily limits or a
 * rate-limit wait beyond MAX_WAIT_MS) moves to the next one, and every move is
 * recorded on the run that finally serves the invocation.
 */
export function chatBackend(providers: Provider[], deps: Deps = {}): Backend {
  const resolved: Required<Deps> = {
    fetch: deps.fetch ?? fetch,
    sleep:
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    log: deps.log ?? log,
  };
  return async (request) => {
    const switches: NonNullable<BackendRun["switches"]> = [];
    for (const p of providers) {
      try {
        const r = await complete(p, request, resolved);
        return {
          output: r.output,
          run: switches.length ? { ...r.run, switches } : r.run,
        };
      } catch (e) {
        if (!(e instanceof WorkerError) || e.kind !== "quota") throw e;
        switches.push({ provider: p.id, model: p.model, reason: e.message });
        resolved.log({
          provider_switch: p.id,
          model: p.model,
          reason: e.message,
        });
      }
    }
    throw new WorkerError(
      "quota",
      "all_providers_exhausted:" +
        switches.map((s) => `${s.provider}=${s.reason}`).join(","),
    );
  };
}

/** EW_ANALYSIS_BACKEND selects the transport: codex (default) or chat. */
export async function configuredBackend(
  spool: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Backend> {
  const name = env.EW_ANALYSIS_BACKEND || "codex";
  if (name === "codex") return codexBackend;
  if (name === "chat") return chatBackend(await chatProviders(spool, env));
  throw Error("unknown_EW_ANALYSIS_BACKEND");
}
