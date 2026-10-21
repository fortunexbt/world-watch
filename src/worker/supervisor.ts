import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { command, CODEX } from "./adapter.js";
export const LABEL = "com.europewatch.luna-worker";
const uid = process.getuid?.();
export const service = `gui/${uid}/${LABEL}`;
export function plistPath() {
  return path.join(homedir(), "Library", "LaunchAgents", LABEL + ".plist");
}
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function plist(root: string) {
  const env = path.join(root, ".runtime", "worker.env");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${[process.execPath, "--import", pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href, path.join(root, "src/worker/cli.ts"), "run"].map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>DOTENV_CONFIG_PATH</key><string>${xml(env)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>ExitTimeOut</key><integer>240</integer><key>StandardOutPath</key><string>${xml(path.join(root, "work/worker/stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(root, "work/worker/stderr.log"))}</string></dict></plist>\n`;
}
export async function supervisorStatus() {
  if (process.platform !== "darwin")
    return { installed: false, running: false, platform: process.platform };
  const r = await command("/bin/launchctl", ["print", service], "", 10000);
  const pid = r.stdout.match(/\bpid = (\d+)/)?.[1];
  return {
    installed: r.code === 0,
    running: !!pid,
    pid: pid ? Number(pid) : null,
    label: LABEL,
    plist: plistPath(),
  };
}
async function assertNoManualWorker(root: string) {
  try {
    const pid = Number(
      await readFile(path.join(root, "work/worker/worker.pid"), "utf8"),
    );
    process.kill(pid, 0);
    throw Error("manual_worker_running_stop_before_install");
  } catch (e) {
    if (String(e).includes("manual_worker_running")) throw e;
  }
}
export async function installSupervisor(
  root: string,
  opts: { print?: boolean; noStart?: boolean } = {},
) {
  if (process.platform !== "darwin")
    throw Error("launchd_install_requires_macos");
  if (opts.print) return { configuration: plist(root) };
  await (await import("./adapter.js")).sandboxDoctor();
  const status = await supervisorStatus();
  if (status.installed)
    throw Error("supervisor_already_loaded_use_status_or_stop");
  await assertNoManualWorker(root);
  const runtime = path.join(root, ".runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "work/worker"), { recursive: true, mode: 0o700 });
  const token =
    process.env.EW_WORKER_TOKEN || process.env.EUROPE_WATCH_WORKER_TOKEN;
  if (!token) throw Error("scoped_worker_token_required_for_install");
  const base = process.env.EW_API_URL;
  if (!base || !base.startsWith("https://"))
    throw Error("remote_https_api_required_for_install");
  const env =
    Object.entries({
      EW_API_URL: base,
      EW_WORKER_TOKEN: token,
      ...(process.env.EW_SITES_ORIGIN
        ? { EW_SITES_ORIGIN: process.env.EW_SITES_ORIGIN }
        : {}),
      ...(process.env.EW_SITES_SERVICE_TOKEN
        ? { EW_SITES_SERVICE_TOKEN: process.env.EW_SITES_SERVICE_TOKEN }
        : {}),
      EW_WORKER_ID: process.env.EW_WORKER_ID || "local-worker",
      EW_BATCH_SIZE: process.env.EW_BATCH_SIZE || "4",
      EW_DAILY_REQUEST_LIMIT: process.env.EW_DAILY_REQUEST_LIMIT || "100",
      EW_DAILY_INPUT_TOKEN_LIMIT:
        process.env.EW_DAILY_INPUT_TOKEN_LIMIT || "2000000",
      EW_OTHER_WORK_REQUEST_RESERVE:
        process.env.EW_OTHER_WORK_REQUEST_RESERVE || "10",
      EW_OTHER_WORK_INPUT_RESERVE:
        process.env.EW_OTHER_WORK_INPUT_RESERVE || "200000",
      EW_CODEX_BIN: process.env.EW_CODEX_BIN || CODEX,
    })
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n";
  await writeFile(path.join(runtime, "worker.env"), env, { mode: 0o600 });
  await mkdir(path.dirname(plistPath()), { recursive: true });
  await writeFile(plistPath(), plist(root), { mode: 0o600 });
  const lint = await command(
    "/usr/bin/plutil",
    ["-lint", plistPath()],
    "",
    10000,
  );
  if (lint.code !== 0) throw Error("invalid_launchd_plist");
  if (!opts.noStart) {
    const start = await command(
      "/bin/launchctl",
      ["bootstrap", `gui/${uid}`, plistPath()],
      "",
      15000,
    );
    if (start.code !== 0)
      throw Error("launchd_bootstrap_failed: " + start.stderr.slice(-400));
  }
  return {
    installed: true,
    started: !opts.noStart,
    plist: plistPath(),
    private_environment: path.join(runtime, "worker.env"),
  };
}
export async function startSupervisor(root?: string) {
  const loaded = await supervisorStatus();
  if (!loaded.installed && root) await assertNoManualWorker(root);
  const r = await command(
    "/bin/launchctl",
    loaded.installed
      ? ["kickstart", service]
      : ["bootstrap", `gui/${uid}`, plistPath()],
    "",
    15000,
  );
  if (r.code !== 0)
    throw Error("launchd_start_failed: " + r.stderr.slice(-300));
  return supervisorStatus();
}
export async function stopSupervisor() {
  const r = await command("/bin/launchctl", ["bootout", service], "", 15000);
  if (r.code !== 0) throw Error("launchd_stop_failed: " + r.stderr.slice(-300));
  return { stopped: true, label: LABEL };
}
