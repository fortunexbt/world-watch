// Local-only showcase: a throwaway database fed by the worldwide structured
// sources (USGS, GDACS, NWS, ECCC, ADSB.lol) and World Watch's routing drop
// detector on RIPEstat. No model runs and no private file is read.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectSources } from "../src/collector/index.js";
import { configuredRegistry } from "../src/collector/registry.js";

const DEMO_SOURCES = [
  "global-usgs-earthquakes",
  "global-gdacs-alerts",
  "us-nws-warnings",
  "ca-eccc-warnings",
  "global-adsblol-emergency-squawks",
  "global-ripestat-routing",
];
const API_PORT = 8797;
const PREVIEW_PORT = Number(process.env.EW_PREVIEW_PORT || 4319);
const REFRESH_MS = 5 * 60000;
const root = path.resolve(import.meta.dirname, "..");
const api = `http://127.0.0.1:${API_PORT}`;
const children: ChildProcess[] = [];
const temp = await mkdtemp(path.join(tmpdir(), "world-watch-demo-"));
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

const token = () => randomBytes(32).toString("base64url");
const secrets = {
  EUROPE_WATCH_OWNER_TOKEN: token(),
  EUROPE_WATCH_COLLECTOR_TOKEN: token(),
  EUROPE_WATCH_WORKER_TOKEN: token(),
};
// Wrangler reads .dev.vars beside its config, so the demo config lives in the
// temp directory and the owner's private .dev.vars is never loaded.
await writeFile(
  path.join(temp, ".dev.vars"),
  Object.entries(secrets)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n"),
  { mode: 0o600 },
);
const config = JSON.parse(
  readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(
    /^\s*\/\/.*$/gm,
    "",
  ),
);
config.main = path.join(root, config.main);
config.assets.directory = path.join(root, "dist");
config.d1_databases[0].migrations_dir = path.join(
  root,
  config.d1_databases[0].migrations_dir,
);
config.vars = { ...config.vars, STORAGE_PAUSED: "0", PUBLIC_ORIGIN: api };
const configPath = path.join(temp, "wrangler.json");
await writeFile(configPath, JSON.stringify(config));
const wrangler = path.join(root, "node_modules/.bin/wrangler");
const state = path.join(temp, "state");

try {
  // A server already on either port would answer the readiness checks below.
  for (const port of [API_PORT, PREVIEW_PORT]) await assertFree(port);
  if (!existsSync(path.join(root, "dist/index.html")))
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  execFileSync(
    wrangler,
    [
      "d1", "migrations", "apply", config.d1_databases[0].database_name,
      "--local", "--persist-to", state, "--config", configPath,
    ],
    { cwd: temp, stdio: "ignore", env: { ...process.env, CI: "1" } },
  );
  children.push(
    spawn(
      wrangler,
      [
        "dev", "--config", configPath, "--local", "--persist-to", state,
        "--ip", "127.0.0.1", "--port", String(API_PORT),
        "--show-interactive-dev-session=false", "--log-level", "error",
      ],
      { cwd: temp, stdio: "ignore" },
    ),
  );
  await waitFor(`${api}/api/health`);
  const sources = configuredRegistry({}).filter((s) =>
    DEMO_SOURCES.includes(s.id),
  );
  const collect = async () => {
    const results = await collectSources(
      { EW_API_URL: api, EW_COLLECTOR_TOKEN: secrets.EUROPE_WATCH_COLLECTOR_TOKEN },
      {
        sources,
        resolveHost: async (host) =>
          (await lookup(host, { all: true })).map((x) => x.address),
      },
    );
    for (const r of results)
      console.log(
        `${new Date().toISOString()}  ${r.source_id}: ${r.status}, ${r.received} records${r.error ? " (" + r.error + ")" : ""}`,
      );
  };
  await collect();
  const { EW_SITES_SERVICE_TOKEN, EW_SITES_ORIGIN, ...env } = process.env;
  children.push(
    spawn(
      path.join(root, "node_modules/.bin/tsx"),
      [path.join(root, "src/operator/preview.ts")],
      {
        cwd: temp,
        stdio: "ignore",
        env: { ...env, EW_API_URL: api, EW_PREVIEW_PORT: String(PREVIEW_PORT) },
      },
    ),
  );
  await waitFor(`http://127.0.0.1:${PREVIEW_PORT}/api/health`);
  console.log(
    `\nWorld Watch demo: http://127.0.0.1:${PREVIEW_PORT}/?hours=168\n` +
      "Live USGS earthquakes, GDACS alerts, NWS and ECCC warnings, ADSB.lol emergency squawks and Internet routing drops, refreshed every 5 minutes. " +
      "Toggle the thermal layer for NASA FIRMS detections. Ctrl-C stops everything and deletes the demo data.",
  );
  setInterval(() => void collect().catch((e) => console.error(String(e))), REFRESH_MS);
} catch (error) {
  console.error(String(error));
  await stop(1);
}

function assertFree(port: number) {
  return new Promise<void>((resolve, reject) => {
    const probe = createServer()
      .once("error", () => reject(Error(`demo_port_in_use: ${port}`)))
      .listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}

async function waitFor(url: string) {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(url).then((r) => r.status < 500, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error(`demo_service_unavailable: ${url}`);
}
