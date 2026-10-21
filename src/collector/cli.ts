import "dotenv/config";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { collectSources } from "./index.js";
import { configuredRegistry } from "./registry.js";
import { fetchSource } from "./fetch.js";
const argv = process.argv.slice(2);
if (argv.some((x) => x.startsWith("--discover="))) {
  const path = argv.find((x) => x.startsWith("--discover="))!.slice(11);
  const { inspectCandidate } = await import("./discovery.js");
  const candidate = JSON.parse(await readFile(path, "utf8"));
  console.log(
    JSON.stringify(
      await inspectCandidate(candidate, {
        resolveHost: async (host) =>
          (await lookup(host, { all: true })).map((x) => x.address),
      }),
      null,
      2,
    ),
  );
} else if (argv.includes("--sources")) {
  console.log(
    JSON.stringify(
      configuredRegistry({
        tflRegistered: process.env.EW_TFL_REGISTERED === "true",
      }),
      null,
      2,
    ),
  );
} else if (argv.includes("--smoke")) {
  const sources = configuredRegistry({
    tflRegistered: process.env.EW_TFL_REGISTERED === "true",
  });
  const filter = argv.find((x) => x.startsWith("--source="))?.slice(9);
  for (const s of sources.filter(
    (s) => (!filter || s.id === filter) && s.status === "enabled",
  )) {
    try {
      const r = await fetchSource(
        s.url,
        {},
        {
          resolveHost: async (host) =>
            (await lookup(host, { all: true })).map((x) => x.address),
        },
      );
      console.log(
        JSON.stringify({
          source: s.id,
          bytes: r.text.length,
          mime: r.contentType,
        }),
      );
    } catch (e) {
      console.log(JSON.stringify({ source: s.id, error: String(e) }));
    }
  }
} else {
  const env = {
    EW_API_URL:
      process.env.EW_API_URL ??
      process.env.EUROPE_WATCH_API_URL ??
      "http://127.0.0.1:8787",
    EW_COLLECTOR_TOKEN:
      process.env.EW_COLLECTOR_TOKEN ??
      process.env.EUROPE_WATCH_COLLECTOR_TOKEN ??
      "",
    EW_TFL_REGISTERED: process.env.EW_TFL_REGISTERED,
    EW_COUNTRIES: process.env.EW_COUNTRIES,
    EW_SITES_SERVICE_TOKEN: process.env.EW_SITES_SERVICE_TOKEN,
    EW_SITES_ORIGIN: process.env.EW_SITES_ORIGIN,
  };
  const once = async () => {
    const results = await collectSources(env, {
      resolveHost: async (host) =>
        (await lookup(host, { all: true })).map((x) => x.address),
    });
    console.log(JSON.stringify({ at: new Date().toISOString(), results }));
  };
  await once();
  if (argv.includes("--watch")) {
    let running = false;
    setInterval(() => {
      if (running) return;
      running = true;
      void once()
        .catch((e) => console.error("collector_cycle_failed", e.message))
        .finally(() => {
          running = false;
        });
    }, 60000);
  }
}
