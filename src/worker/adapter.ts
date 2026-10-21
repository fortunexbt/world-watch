import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, existsSync } from "node:fs";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  Batch,
  CONTRACT_VERSION,
  validateResult,
  type JobInput,
  type ModelRun,
  type AnalysisResult,
} from "../shared/contracts.js";
import { DailyBudget } from "./budget.js";
import { WireBatch, WireResult, compactInputs, restoreResult } from "./wire.js";
import { ANALYST, PROMPT_VERSION } from "./analyst.js";
const codexCandidate =
  process.env.EW_CODEX_BIN ||
  [
    path.join(homedir(), ".local/bin/codex"),
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .map((p) => path.join(p, "codex")),
  ].find(existsSync);
export const CODEX =
  codexCandidate && existsSync(codexCandidate)
    ? realpathSync(codexCandidate)
    : codexCandidate || "codex";
export function analysisKey(
  input: Pick<JobInput, "report_id" | "content_revision">,
) {
  return JSON.stringify([input.report_id, input.content_revision]);
}
export class WorkerError extends Error {
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
  }
}
export function classifyError(message: string) {
  if (
    /sandbox.*failed|Operation not permitted|isolation_probe|unexpected_tool_attempt/i.test(
      message,
    )
  )
    return "isolation";
  if (/usage.limit|quota|rate.limit|429|limit reached/i.test(message))
    return "quota";
  if (/auth|sign.in|login|unauthorized|401|token.expired/i.test(message))
    return "auth";
  if (/model.*(not found|unsupported|access)|model_not_found/i.test(message))
    return "model";
  if (/schema|invalid|identity|evidence/i.test(message)) return "invalid";
  return "transport";
}
export async function command(
  bin: string,
  args: string[],
  stdin = "",
  timeout = 180000,
  maxBytes = 3000000,
  extraEnv: Record<string, string> = {},
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      const p = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CODEX_HOME: process.env.CODEX_HOME,
          TMPDIR: process.env.TMPDIR,
          LANG: "en_US.UTF-8",
          ...extraEnv,
        },
        detached: true,
      });
      let stdout = "",
        stderr = "",
        size = 0;
      const kill = () => {
        try {
          process.kill(-p.pid!, "SIGKILL");
        } catch {
          p.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        kill();
        reject(new WorkerError("transport", "codex_timeout"));
      }, timeout);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(
          (e as any).code === "ENOENT"
            ? new WorkerError("model", "codex_client_missing_set_EW_CODEX_BIN")
            : e,
        );
      });
      p.stdout.on("data", (d) => {
        size += d.length;
        if (size > maxBytes) {
          kill();
          return;
        }
        stdout += d.toString();
      });
      p.stderr.on("data", (d) => {
        size += d.length;
        if (size > maxBytes) {
          kill();
          return;
        }
        stderr += d.toString();
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (size > maxBytes)
          reject(new WorkerError("invalid", "codex_output_limit"));
        else resolve({ stdout, stderr, code: code ?? -1 });
      });
      p.stdin.end(stdin);
    },
  );
}
const featureOff = [
  "unified_exec",
  "shell_snapshot",
  "shell_tool",
  "apps",
  "plugins",
  "multi_agent",
  "memories",
  "chronicle",
  "hooks",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "view_image",
  "skill_search",
  "sleep_tool",
  "goals",
  "tool_suggest",
];
export function extractionArgs(
  dir: string,
  schema: string,
  out: string,
  tier = "fast",
  effort = "low",
) {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-c",
    "suppress_unstable_features_warning=true",
    "-m",
    "gpt-6-luna",
    "-C",
    dir,
    "-c",
    `model_instructions_file=${JSON.stringify(path.join(dir, "analyst.txt"))}`,
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "skills.include_instructions=false",
    ...[
      "include_apps_instructions",
      "include_collaboration_mode_instructions",
      "include_environment_context",
      "include_permissions_instructions",
    ].flatMap((k) => ["-c", `${k}=false`]),
    "--output-schema",
    schema,
    "--output-last-message",
    out,
    "-c",
    'approval_policy="never"',
    "-c",
    'default_permissions="extractor"',
    "-c",
    `permissions.extractor.filesystem=${JSON.stringify({ ":root": "deny", ":minimal": "read", "/private/tmp": "deny", "/tmp": "deny", "/var/tmp": "deny", "/private/var/tmp": "deny", [dir]: "read", [path.dirname(CODEX)]: "read", [path.dirname(CODEX)]: "read" }).replace(/:"/g, '="')}`,
    "-c",
    "permissions.extractor.network.enabled=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "features.fast_mode=true",
    "-c",
    `service_tier=${JSON.stringify(tier)}`,
    "-c",
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    "-c",
    "features.skip_host_skill_discovery=true",
    ...featureOff.flatMap((f) => ["-c", `features.${f}=false`]),
    "-",
  ];
}
export async function sandboxDoctor() {
  const root = await mkdtemp(path.join(tmpdir(), "ew-isolation-")),
    dir = path.join(root, "allowed"),
    home = path.join(root, "clean-config"),
    privateFile = path.join(root, "private-canary"),
    sharedPrivate = await mkdtemp(
      (process.platform === "darwin" ? "/private/tmp/" : "/tmp/") +
        "ew-private-canary-",
    );
  try {
    await mkdir(dir);
    await mkdir(home);
    await writeFile(path.join(dir, "input.txt"), "public report");
    await writeFile(privateFile, "harmless private canary", { mode: 0o600 });
    await writeFile(
      path.join(sharedPrivate, "canary"),
      "harmless shared-temp private canary",
      { mode: 0o600 },
    );
    await symlink(privateFile, path.join(dir, "escape"));
    const fsPolicy = `{ ":root" = "deny", ":minimal" = "read", "/private/tmp" = "deny", "/tmp" = "deny", "/var/tmp" = "deny", "/private/var/tmp" = "deny", ${JSON.stringify(dir)} = "read", ${JSON.stringify(path.dirname(CODEX))} = "read" }`;
    const probe =
      '/bin/cat "$1/input.txt" >/dev/null 2>&1 || exit 21; for p in "$2" "$3/.codex/models_cache.json" "$3/.codex/config.toml" "$3/.codex/memories/MEMORY.md" "$3/.codex/auth.json" "$1/escape" "$4"; do if /bin/cat "$p" >/dev/null 2>&1; then echo PRIVATE_OPEN_ALLOWED; exit 22; fi; done; if (printf x >>"$1/input.txt") 2>/dev/null; then echo WRITE_ALLOWED; exit 23; fi; echo ISOLATION_OPEN_OK';
    const r = await command(
      CODEX,
      [
        "sandbox",
        "-P",
        "extractor",
        "-C",
        dir,
        "-c",
        `permissions.extractor.filesystem=${fsPolicy}`,
        "-c",
        "permissions.extractor.network.enabled=false",
        "/bin/sh",
        "-c",
        probe,
        "ew",
        dir,
        privateFile,
        process.env.HOME || homedir(),
        path.join(sharedPrivate, "canary"),
      ],
      "",
      10000,
      3000000,
      { CODEX_HOME: home },
    );
    if (r.code !== 0 || !r.stdout.includes("ISOLATION_OPEN_OK"))
      throw new WorkerError(
        "isolation",
        "filesystem_actual_open_isolation_probe_failed",
      );
    return {
      passed: true,
      checks: [
        "actual public-file open succeeds",
        "actual private canary/config/cache/memory/auth opens denied",
        "private mode0600 shared-temp canary open denied",
        "symlink escape denied",
        "actual write denied",
        "tool network disabled by policy",
        "probe uses empty config home to match exec --ignore-user-config",
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sharedPrivate, { recursive: true, force: true });
  }
}

async function analyzeChunk(
  inputs: JobInput[],
  options: {
    tier?: string;
    effort?: string;
    timeout?: number;
    budget?: DailyBudget;
  } = {},
) {
  if (!inputs.length || inputs.length > 12)
    throw new WorkerError("invalid", "bounded_batch_required");
  if (Buffer.byteLength(JSON.stringify(inputs)) > 80000)
    throw new WorkerError("invalid", "batch_input_limit");
  const dir = await mkdtemp(path.join(tmpdir(), "ew-luna-"));
  try {
    await mkdir(dir, { recursive: true });
    const schema = path.join(dir, "schema.json"),
      out = path.join(dir, "result.json");
    const payload = compactInputs(inputs);
    const jsonSchema: any = zodToJsonSchema(WireBatch, {
      $refStrategy: "none",
      target: "openAi",
    });
    jsonSchema.properties.results.items.properties.index.enum = inputs.map(
      (_, i) => i,
    );
    const ids = [
      ...new Set(inputs.flatMap((r) => r.excerpts.map((e) => e.id))),
    ];
    const claimSchema =
      jsonSchema.properties.results.items.properties.claims.items;
    const citations = [
      claimSchema.properties.evidence_ids,
      claimSchema.properties.places.items.properties.evidence_ids,
      claimSchema.properties.official_instruction.anyOf[0].properties
        .evidence_ids,
    ];
    for (const citation of citations) {
      citation.minItems = 1;
      citation.items.enum = ids;
    }

    await writeFile(path.join(dir, "analyst.txt"), ANALYST);
    await writeFile(schema, JSON.stringify(jsonSchema));
    const version = await command(CODEX, ["--version"], "", 10000);
    const invocation_id = randomUUID();
    if (options.budget) {
      try {
        await options.budget.reserve(
          invocation_id,
          6000 + Math.ceil(Buffer.byteLength(JSON.stringify(payload)) / 3),
        );
      } catch (e) {
        throw new WorkerError("budget", String(e));
      }
    }
    const start = Date.now();
    const args = extractionArgs(
      dir,
      schema,
      out,
      options.tier || "fast",
      options.effort || "low",
    );
    const r = await command(
      CODEX,
      args,
      JSON.stringify(payload),
      options.timeout || 180000,
    );
    const events = r.stdout.split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    if (options.budget)
      await options.budget.record(
        invocation_id,
        events.find((e) => e.type === "turn.completed")?.usage,
      );
    if (r.code !== 0)
      throw new WorkerError(
        classifyError(r.stderr + r.stdout),
        `codex_exit_${r.code}: ${(r.stderr + r.stdout).slice(-1400)}`,
      );
    const errors = events.filter(
      (e) =>
        e.item?.type === "error" &&
        !e.item.message?.startsWith("Under-development features enabled:"),
    );
    if (errors.length)
      throw new WorkerError(
        classifyError(JSON.stringify(errors)),
        "codex_error_event:" + JSON.stringify(errors).slice(0, 1000),
      );
    const tools = events.filter(
      (e) =>
        e.item?.type &&
        !["agent_message", "reasoning", "error"].includes(e.item.type),
    );
    if (tools.length)
      throw new WorkerError(
        "isolation",
        "unexpected_tool_attempt:" +
          tools
            .map((e) => JSON.stringify(e.item))
            .join(",")
            .slice(0, 1200),
      );
    let envelope: any;
    try {
      envelope = JSON.parse(await readFile(out, "utf8"));
    } catch {
      throw new WorkerError("invalid", "missing_or_invalid_json_output");
    }
    if (!Array.isArray(envelope.results))
      throw new WorkerError("invalid", "invalid_batch_envelope");
    const run: ModelRun = {
      invocation_id,
      requested_model: "gpt-6-luna",
      requested_tier: options.tier || "fast",
      actual_model: null,
      actual_tier: null,
      client_version: version.stdout.trim(),
      prompt_version: PROMPT_VERSION,
      schema_version: CONTRACT_VERSION + "/wire-1",
      duration_ms: Date.now() - start,
      usage: events.find((e) => e.type === "turn.completed")?.usage ?? null,
      tool_attempts: tools.length,
    };
    const accepted = new Map<string, AnalysisResult>(),
      invalid = new Map<string, string>();
    for (const item of envelope.results) {
      const input = Number.isInteger(item.index)
        ? inputs[item.index]
        : undefined;
      if (!input) continue;
      const id = analysisKey(input);
      if (accepted.has(id) || invalid.has(id)) {
        accepted.delete(id);
        invalid.set(id, "duplicate_result");
        continue;
      }
      try {
        accepted.set(id, restoreResult(WireResult.parse(item), input));
      } catch (e) {
        invalid.set(id, String(e));
      }
    }
    for (const input of inputs)
      if (!accepted.has(analysisKey(input)) && !invalid.has(analysisKey(input)))
        invalid.set(analysisKey(input), "missing_result");
    return { accepted, invalid, run };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function analyze(
  inputs: JobInput[],
  options: {
    tier?: string;
    effort?: string;
    timeout?: number;
    budget?: DailyBudget;
  } = {},
): Promise<{
  accepted: Map<string, AnalysisResult>;
  invalid: Map<string, string>;
  run: ModelRun;
}> {
  if (!inputs.length || inputs.length > 12)
    throw new WorkerError("invalid", "bounded_batch_required");
  try {
    return await analyzeChunk(inputs, options);
  } catch (e) {
    if (
      !(e instanceof WorkerError) ||
      e.kind !== "invalid" ||
      inputs.length === 1
    )
      throw e;
    const mid = Math.ceil(inputs.length / 2);
    const a = await analyze(inputs.slice(0, mid), options),
      b = await analyze(inputs.slice(mid), options);
    return {
      accepted: new Map([...a.accepted, ...b.accepted]),
      invalid: new Map([...a.invalid, ...b.invalid]),
      run: {
        ...b.run,
        duration_ms: a.run.duration_ms + b.run.duration_ms,
        tool_attempts: a.run.tool_attempts + b.run.tool_attempts,
        usage: { split_batches: [a.run.usage, b.run.usage] },
      },
    };
  }
}
