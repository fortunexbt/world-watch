import "dotenv/config";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CODEX, analyze, command, sandboxDoctor } from "./adapter.js";
import { DailyBudget } from "./budget.js";
import { chatProviders, configuredBackend } from "./chat.js";
import { triageHeadlines } from "./triage.js";
import { RemoteWorker } from "./worker.js";
import {
  installSupervisor,
  supervisorStatus,
  startSupervisor,
  stopSupervisor,
} from "./supervisor.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const state = process.env.EW_WORKER_STATE || path.join(root, "work", "worker");
const pidFile = path.join(state, "worker.pid");
async function trackedPid() {
  try {
    const pid = Number(await readFile(pidFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 2) return null;
    const r = await command(
      "/bin/ps",
      ["-p", String(pid), "-o", "command="],
      "",
      5000,
    );
    return r.code === 0 &&
      r.stdout.includes(path.join(root, "src/worker/cli.ts")) &&
      /\brun\b/.test(r.stdout)
      ? pid
      : null;
  } catch {
    return null;
  }
}
const cmd = process.argv[2] || "status";
const chat = process.env.EW_ANALYSIS_BACKEND === "chat";
const spool = path.join(state, "spool");
await mkdir(state, { recursive: true, mode: 0o700 });
if (cmd === "doctor" && chat) {
  console.log(
    JSON.stringify(
      {
        backend: "chat",
        providers: (await chatProviders(spool)).map(
          ({ key, budget, ...p }) => ({ ...p, key_present: !!key }),
        ),
        budget: await new DailyBudget(
          path.join(spool, "daily-budget.json"),
        ).summary(),
      },
      null,
      2,
    ),
  );
} else if (cmd === "doctor") {
  const version = await command(CODEX, ["--version"], "", 10000);
  const auth = await command(CODEX, ["login", "status"], "", 10000);
  console.log(
    JSON.stringify(
      {
        binary: CODEX,
        version: version.stdout.trim(),
        auth: (auth.stdout + auth.stderr).trim(),
        isolation: await sandboxDoctor(),
        configured_remote: !!process.env.EW_API_URL,
        configured_scoped_credential: !!process.env.EW_WORKER_TOKEN,
        model: "gpt-6-luna",
        requested_tier: "fast",
        actual_tier: null,
        budget: await new DailyBudget(
          path.join(spool, "daily-budget.json"),
        ).summary(),
      },
      null,
      2,
    ),
  );
} else if (cmd === "status") {
  let pid = 0,
    alive = false;
  try {
    pid = (await trackedPid()) || 0;
    alive = !!pid;
  } catch {}
  const supervisor = await supervisorStatus();
  console.log(
    JSON.stringify({
      running: alive || supervisor.running,
      pid: alive ? pid : (supervisor.pid ?? null),
      state,
      supervisor,
    }),
  );
} else if (cmd === "stop") {
  if ((await supervisorStatus()).installed) {
    console.log(JSON.stringify(await stopSupervisor()));
  } else
    try {
      const pid = await trackedPid();
      if (!pid) throw Error("worker_not_running");
      process.kill(pid, "SIGTERM");
      console.log("Stop requested");
    } catch {
      console.log("Worker is not running");
    }
} else if (cmd === "install") {
  console.log(
    JSON.stringify(
      await installSupervisor(root, {
        print: process.argv.includes("--print"),
        noStart: process.argv.includes("--no-start"),
      }),
      null,
      2,
    ),
  );
} else if (cmd === "start") {
  if (process.platform === "darwin") {
    try {
      await readFile((await import("./supervisor.js")).plistPath());
      console.log(JSON.stringify(await startSupervisor(root)));
      process.exit(0);
    } catch (e) {
      if (!String(e).includes("ENOENT")) throw e;
    }
  }
  try {
    if (await trackedPid()) throw Error("worker_already_running");
  } catch (e) {
    if (String(e).includes("already_running")) throw e;
  }
  const p = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "run"],
    { cwd: root, detached: true, stdio: "ignore", env: process.env },
  );
  p.unref();
  console.log(JSON.stringify({ started: true, pid: p.pid }));
} else if (cmd === "triage") {
  // Headline records, one JSON object per line, from the file named next or stdin.
  const file = process.argv[3];
  const text = file
    ? await readFile(file, "utf8")
    : await new Response(process.stdin as any).text();
  if (!chat) await sandboxDoctor();
  console.log(
    JSON.stringify(
      await triageHeadlines(
        text
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line)),
        {
          backend: await configuredBackend(spool),
          budget: new DailyBudget(path.join(spool, "daily-budget.json")),
        },
      ),
      null,
      2,
    ),
  );
} else if (cmd === "once" || cmd === "run" || cmd === "brief-once") {
  if (!chat) await sandboxDoctor();
  const backend = await configuredBackend(spool);
  const worker = new RemoteWorker({
    base: process.env.EW_API_URL || "http://127.0.0.1:4310",
    token:
      process.env.EW_WORKER_TOKEN ||
      process.env.EUROPE_WATCH_WORKER_TOKEN ||
      "",
    id: process.env.EW_WORKER_ID || hostname(),
    spool,
    analyzer: (inputs, options) => analyze(inputs, { ...options, backend }),
    briefs: !chat,
  });
  if (cmd === "brief-once" && chat) throw Error("briefs_require_codex_backend");
  if (cmd === "brief-once")
    console.log(JSON.stringify(await worker.briefOnce()));
  else if (cmd === "once")
    console.log(
      JSON.stringify(await worker.once(Number(process.env.EW_BATCH_SIZE || 4))),
    );
  else {
    const abort = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => abort.abort());
    await writeFile(pidFile, String(process.pid), { mode: 0o600 });
    try {
      await worker.run(abort.signal);
    } finally {
      await unlink(pidFile).catch(() => {});
    }
  }
} else
  throw Error(
    "Usage: worker doctor|once|brief-once|run|start|stop|status|install|triage [file.jsonl]",
  );
