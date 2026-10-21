import { spawn } from "node:child_process";
import { writeFile, realpath } from "node:fs/promises";
const mode = process.argv[2] ?? "backend";
async function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", env: process.env });
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const forward = () => child.kill(signal);
      process.once(signal, forward);
      child.once("exit", () => process.removeListener(signal, forward));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(Error(`process_failed:${bin}:${code ?? signal}`)),
    );
  });
}
if (mode === "backend") {
  const keys = [
    "EUROPE_WATCH_OWNER_TOKEN",
    "EUROPE_WATCH_COLLECTOR_TOKEN",
    "EUROPE_WATCH_WORKER_TOKEN",
  ];
  if (keys.some((k) => !process.env[k]))
    throw Error("all_three_distinct_local_application_tokens_required");
  if (new Set(keys.map((k) => process.env[k])).size !== 3)
    throw Error("application_scopes_require_distinct_tokens");
  // Construct configuration as data. Neither token values nor source content enter shell code.
  await writeFile(
    "/app/.dev.vars",
    keys.map((k) => `${k}=${JSON.stringify(process.env[k])}`).join("\n") + "\n",
    { mode: 0o600 },
  );
  const wrangler = await realpath(
    new URL("../node_modules/.bin/wrangler", import.meta.url),
  );
  await run(process.execPath, [
    wrangler,
    "d1",
    "migrations",
    "apply",
    "europe-watch",
    "--local",
    "--persist-to",
    "/data/wrangler",
  ]);
  await run(process.execPath, [
    wrangler,
    "dev",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    "8787",
    "--persist-to",
    "/data/wrangler",
    "--var",
    "PUBLIC_ORIGIN:http://127.0.0.1:8787",
  ]);
} else if (mode === "analysis") {
  const origin = process.env.EW_API_URL ?? "";
  const local =
    process.env.EW_ALLOW_LOCAL_EMULATOR === "true" &&
    /^http:\/\/127\.0\.0\.1:8787\/?$/.test(origin);
  if (!local && !/^https:\/\//.test(origin))
    throw Error(
      "container_worker_requires_explicit_remote_https_origin_or_local_emulator",
    );
  if (!process.env.EW_WORKER_TOKEN) throw Error("scoped_worker_token_required");
  // This performs actual access-isolation probes before any report reaches Codex.
  await run(process.execPath, [
    "--import",
    "tsx",
    "src/worker/cli.ts",
    "doctor",
  ]);
  await run(process.execPath, ["--import", "tsx", "src/worker/cli.ts", "run"]);
} else throw Error("expected_backend_or_analysis");
