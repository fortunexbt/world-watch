import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import {
  buildPublicSnapshot,
  CARRY_FORWARD_SECONDS,
  GEOSPATIAL_REFRESH_SECONDS,
  PUBLIC_SOURCES,
  reusableGeospatial,
} from "../src/public/snapshot.js";
import { CEMS_URL, FIRMS_SENSORS } from "../src/server/geospatial.js";
import { USGS_FEED_URL } from "../src/collector/adapters/usgs.js";
import { EMSC_QUERY_URL } from "../src/collector/adapters/emsc.js";
import { GDACS_EVENTS_URL } from "../src/collector/adapters/gdacs.js";
import { NWS_ALERTS_URL } from "../src/collector/adapters/nws.js";
import { ECCC_ALERTS_URL } from "../src/collector/adapters/eccc.js";
import { sourceRegistry } from "../src/collector/registry.js";
import {
  BRIEF_WINDOWS,
  MANIFEST,
  PUBLIC_FILE_LIMITS,
} from "../src/shared/public-snapshot.js";
import type { IncidentView } from "../src/shared/contracts.js";
import { situations } from "../src/shared/fusion.js";

// Real responses trimmed for the hazard tests; FIRMS and CEMS bodies are synthetic and dated
// relative to the clock, because both catalogues keep only recent records. EMSC is asked for the
// past day from the clock, so its query is matched without the start time.
const feeds: Record<string, unknown> = {
  [USGS_FEED_URL]: JSON.parse(
    readFileSync("tests/fixtures/usgs-summary.json", "utf8"),
  ),
  [GDACS_EVENTS_URL]: JSON.parse(
    readFileSync("tests/fixtures/gdacs-events.json", "utf8"),
  ),
  [NWS_ALERTS_URL]: JSON.parse(
    readFileSync("tests/fixtures/nws-alerts.json", "utf8"),
  ),
  [ECCC_ALERTS_URL]: JSON.parse(
    readFileSync("tests/fixtures/eccc-alerts.json", "utf8"),
  ),
};
const emsc = JSON.parse(
  readFileSync("tests/fixtures/emsc-events.json", "utf8"),
);
const recent = () => {
  const iso = new Date(Date.now() - 3600000).toISOString();
  return [iso.slice(0, 10), iso.slice(11, 13) + iso.slice(14, 16)];
};
function upstream(requests: { url: string; method: string }[] = []) {
  return (async (input: any, init: any = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET" });
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    if (feeds[url]) return Response.json(feeds[url]);
    if (url.startsWith(EMSC_QUERY_URL + "?")) return Response.json(emsc);
    const sensor = FIRMS_SENSORS.find((s) => s.url === url);
    if (sensor) {
      const [date, time] = recent();
      return new Response(
        "latitude,longitude,acq_date,acq_time,satellite,confidence\n" +
          [
            [41, 12],
            [-17.8, 179.5],
            [64.1, -21.9],
          ]
            .map(
              ([lat, lon]) =>
                `${lat},${lon},${date},${time},${sensor.satellite},nominal`,
            )
            .join("\n"),
      );
    }
    const eventTime = new Date(Date.now() - 7200000).toISOString().slice(0, 19);
    if (url === CEMS_URL)
      return Response.json({
        results: [{ code: "EMSR935", eventTime, n_aois: "1" }],
      });
    if (url.includes("/public-activations/?code=EMSR935"))
      return Response.json({
        results: [
          {
            code: "EMSR935",
            name: "Flood Spain",
            category: "Flood",
            eventTime,
            sensitive: false,
            aois: [
              {
                name: "Moraira",
                number: 1,
                extent: "POLYGON ((0 38,1 38,1 39,0 38))",
              },
            ],
          },
        ],
      });
    throw Error("unexpected upstream request " + url);
  }) as typeof fetch;
}

// An allowlist by role: connectivity measurements (RIPEstat forbids redistribution and its logo
// permission is pending), aviation signals (ADSB.lol asks production users to contact it first)
// and GDELT news signals (publisher headlines, and no baseline in a stateless run) stay out of
// the public demo even though the private app displays them.
test("public sources are the enabled structured hazard feeds whose rights permit display", () => {
  assert.deepEqual(PUBLIC_SOURCES.map((s) => s.id).sort(), [
    "ca-eccc-warnings",
    "global-emsc-earthquakes",
    "global-gdacs-alerts",
    "global-usgs-earthquakes",
    "us-nws-warnings",
  ]);
  assert(
    PUBLIC_SOURCES.every((s) => s.rights.display && s.rights.ai === false),
  );
  // GDACS may be displayed but not redistributed, so the demo shows it and offers no export.
  assert.equal(
    PUBLIC_SOURCES.find((s) => s.id === "global-gdacs-alerts")!.rights
      .redistribute,
    false,
  );
  assert(!PUBLIC_SOURCES.some((s) => s.id.startsWith("meteoalarm-")));
});

test("the snapshot publishes the API's projection, briefs for every window and a bounded geospatial catalogue", async () => {
  const requests: { url: string; method: string }[] = [];
  const { manifest, files, results } = await buildPublicSnapshot({
    fetch: upstream(requests),
  });
  assert.deepEqual(
    results.map((r) => [r.source_id, r.status]).sort(),
    PUBLIC_SOURCES.map((s) => [s.id, "ok"]).sort(),
  );
  // Only GET reads of the public sources leave the process; ingest and reconciliation stay in memory.
  assert(requests.every((r) => r.method === "GET"));
  assert(
    !requests.some(
      (r) => new URL(r.url).hostname === "public-snapshot.invalid",
    ),
  );
  assert.deepEqual(
    [...files.keys()].sort(),
    [MANIFEST, ...Object.keys(manifest.files)].sort(),
  );
  for (const [name, text] of files)
    assert(
      Buffer.byteLength(text) <=
        PUBLIC_FILE_LIMITS[name as keyof typeof PUBLIC_FILE_LIMITS],
    );
  for (const [name, { bytes }] of Object.entries(manifest.files))
    assert.equal(bytes, Buffer.byteLength(files.get(name)!));
  const { incidents } = JSON.parse(files.get("incidents.json")!) as {
    incidents: IncidentView[];
  };
  assert(incidents.length > 0);
  for (const incident of incidents)
    for (const report of incident.reports) {
      assert(PUBLIC_SOURCES.some((s) => s.id === report.source_id));
      assert.equal(report.rights.display, true);
    }
  assert(incidents.every((i) => i.analyzed_at === null));
  // Linked records fuse: USGS, GDACS and EMSC for Vanuatu, USGS and EMSC for three more quakes,
  // and GDACS and EMSC for Hokkaido.
  assert.equal(situations(incidents).length, incidents.length - 6);
  const briefs = JSON.parse(files.get("brief.json")!);
  assert.deepEqual(Object.keys(briefs).sort(), [...BRIEF_WINDOWS].sort());
  assert.equal(briefs["0"].kind, "structured");
  const geo = JSON.parse(files.get("geospatial.json")!);
  // Three detections per sensor still delivering; an ended sensor is not read.
  assert.equal(
    geo.features.filter((f: any) => f.layer === "thermal").length,
    3 *
      FIRMS_SENSORS.filter(
        (s) => !s.ended || Date.parse(s.ended.at) > Date.now(),
      ).length,
  );
  assert.equal(
    geo.features.filter((f: any) => f.layer === "emergency_mapping").length,
    1,
  );
  assert(
    geo.sources.every(
      (s: any) => s.cadence_seconds === GEOSPATIAL_REFRESH_SECONDS,
    ),
  );
  assert.equal(manifest.analysis, "none");
  assert.deepEqual(
    manifest.sources.map((s) => [s.id, s.redistribute]).sort(),
    PUBLIC_SOURCES.map((s) => [s.id, s.rights.redistribute]).sort(),
  );
  assert(manifest.sources.every((s) => s.attribution.length > 0));
});

test("a source whose rights forbid display is never collected or published", async () => {
  const requests: { url: string; method: string }[] = [];
  const usgs = sourceRegistry.find((s) => s.id === "global-usgs-earthquakes")!;
  const hidden = { ...usgs, rights: { ...usgs.rights, display: false } };
  const gdacs = sourceRegistry.find((s) => s.id === "global-gdacs-alerts")!;
  const { manifest, files } = await buildPublicSnapshot({
    fetch: upstream(requests),
    sources: [hidden, gdacs],
  });
  assert(!requests.some((r) => r.url === USGS_FEED_URL));
  assert.deepEqual(
    manifest.sources.map((s) => s.id),
    ["global-gdacs-alerts"],
  );
  const { incidents, sources } = JSON.parse(files.get("incidents.json")!);
  assert(incidents.length > 0);
  assert(
    incidents.every((i: IncidentView) =>
      i.reports.every((r) => r.source_id === gdacs.id),
    ),
  );
  assert(!sources.some((s: any) => s.id === usgs.id));
});

test("every file has a byte ceiling and an oversized snapshot fails instead of publishing", async () => {
  const usgs = sourceRegistry.find((s) => s.id === "global-usgs-earthquakes")!;
  await assert.rejects(
    buildPublicSnapshot({
      fetch: upstream(),
      sources: [{ ...usgs, name: "x".repeat(PUBLIC_FILE_LIMITS[MANIFEST]) }],
    }),
    /public_snapshot_size: manifest\.json/,
  );
});

test("a run that reaches no source fails, so the last published snapshot stays live", async () => {
  await assert.rejects(
    buildPublicSnapshot({
      fetch: (async () =>
        new Response("unavailable", { status: 503 })) as typeof fetch,
    }),
    /public_snapshot_sources_unavailable/,
  );
});

test("a failed read keeps the source's last published records for an hour, then drops them", async () => {
  const first = await buildPublicSnapshot({ fetch: upstream() });
  const previous = {
    manifest: JSON.parse(first.files.get(MANIFEST)!),
    incidents: JSON.parse(first.files.get("incidents.json")!),
  };
  const gdacsDown = (async (input: any, init: any) =>
    String(input).startsWith(GDACS_EVENTS_URL)
      ? new Response("unavailable", { status: 503 })
      : upstream()(input, init)) as typeof fetch;
  const gdacsIds = (files: Map<string, string>) =>
    JSON.parse(files.get("incidents.json")!)
      .incidents.filter(
        (i: IncidentView) => i.reports[0].source_id === "global-gdacs-alerts",
      )
      .map((i: IncidentView) => i.id)
      .sort();
  const kept = await buildPublicSnapshot({ fetch: gdacsDown, previous });
  const gdacs = kept.manifest.sources.find(
    (s) => s.id === "global-gdacs-alerts",
  )!;
  assert.equal(gdacs.status, "error");
  assert(gdacs.carried_forward > 0);
  assert.equal(gdacs.last_success_at, first.manifest.generated_at);
  assert.deepEqual(gdacsIds(kept.files), gdacsIds(first.files));
  assert(
    JSON.parse(kept.files.get("brief.json")!)["0"].references.some((r: any) =>
      gdacsIds(first.files).includes(r.incident_id),
    ),
  );
  const hourAgo = new Date(
    Date.now() - CARRY_FORWARD_SECONDS * 1000,
  ).toISOString();
  const stale = await buildPublicSnapshot({
    fetch: gdacsDown,
    previous: {
      ...previous,
      manifest: {
        ...previous.manifest,
        sources: previous.manifest.sources.map((s: any) => ({
          ...s,
          last_success_at: hourAgo,
        })),
      },
    },
  });
  assert.deepEqual(gdacsIds(stale.files), []);
  assert.equal(
    stale.manifest.sources.find((s) => s.id === "global-gdacs-alerts")!
      .last_success_at,
    hourAgo,
  );
});

test("the manifest states each source's and sensor's coverage, and lag counts only revisions new since the previous run", async () => {
  const first = await buildPublicSnapshot({ fetch: upstream() });
  for (const s of first.manifest.sources) {
    assert(["observed", "quiet"].includes(s.coverage), s.id + " " + s.coverage);
    // A run from an empty database holds the issuers' backlog, which is not latency.
    assert.equal(s.latency.issuer_to_ingest.n, 0);
    assert.equal(s.latency.ingest_to_publication.p90, 0);
  }
  const firms = first.manifest.layers.find((l) => l.id === "firms")!;
  assert.equal(firms.coverage, "observed");
  assert.deepEqual(
    firms.sensors!.map((s) => s.id),
    FIRMS_SENSORS.map((s) => s.id),
  );
  const previous = () => ({
    manifest: JSON.parse(first.files.get(MANIFEST)!),
    incidents: JSON.parse(first.files.get("incidents.json")!),
  });
  const updated = structuredClone(feeds[USGS_FEED_URL]) as any;
  updated.features[0].properties.updated = Date.now() - 60000;
  const revised = (async (input: any, init: any) =>
    String(input) === USGS_FEED_URL
      ? Response.json(updated)
      : upstream()(input, init)) as typeof fetch;
  const second = await buildPublicSnapshot({ fetch: revised, previous: previous() });
  const usgs = second.manifest.sources.find(
    (s) => s.id === "global-usgs-earthquakes",
  )!;
  assert.equal(usgs.latency.issuer_to_ingest.n, 1);
  assert(usgs.latency.issuer_to_ingest.p50! >= 60 && usgs.latency.issuer_to_ingest.p50! < 120);
  assert(
    second.manifest.sources
      .filter((s) => s.id !== usgs.id)
      .every((s) => s.latency.issuer_to_ingest.n === 0),
  );
  // The samples ride in the published source health, so the next run keeps them.
  const third = await buildPublicSnapshot({
    fetch: revised,
    previous: {
      manifest: JSON.parse(second.files.get(MANIFEST)!),
      incidents: JSON.parse(second.files.get("incidents.json")!),
    },
  });
  assert.equal(
    third.manifest.sources.find((s) => s.id === usgs.id)!.latency.issuer_to_ingest.n,
    1,
  );
});

test("a recent healthy catalogue is reused instead of downloading the satellite files again", async () => {
  const now = Date.now();
  const layer = (status: "ok" | "error", minutes: number) => ({
    id: "firms" as const,
    status,
    checked_at: new Date(now - minutes * 60000).toISOString(),
    cadence_seconds: GEOSPATIAL_REFRESH_SECONDS,
    features_count: 0,
    total_available: 0,
    truncated: false,
    source_url: "https://firms.modaps.eosdis.nasa.gov/active_fire/",
    attribution: "NASA FIRMS",
    license_url: "https://www.earthdata.nasa.gov/",
  });
  const catalog = (status: "ok" | "error", minutes: number) => ({
    bbox: [-180, -90, 180, 90] as [number, number, number, number],
    features: [],
    sources: [layer(status, minutes)],
  });
  assert.equal(reusableGeospatial(catalog("ok", 20), now), true);
  assert.equal(reusableGeospatial(catalog("ok", 56), now), false);
  assert.equal(reusableGeospatial(catalog("error", 5), now), false);
  assert.equal(reusableGeospatial(undefined, now), false);
  const requests: { url: string; method: string }[] = [];
  const { files } = await buildPublicSnapshot({
    fetch: upstream(requests),
    previous: { geospatial: catalog("ok", 20) },
  });
  assert(
    !requests.some(
      (r) => r.url.includes("firms.modaps") || r.url.includes("copernicus"),
    ),
  );
  assert.equal(
    JSON.parse(files.get("geospatial.json")!).sources[0].checked_at,
    layer("ok", 20).checked_at,
  );
});

test(
  "the public build reads only static files, sends no credential and has no owner or write interface",
  { timeout: 120000 },
  async () => {
    const out = mkdtempSync(path.join(tmpdir(), "world-watch-public-"));
    let browser: any;
    const site = createServer();
    try {
      execFileSync(
        process.execPath,
        [
          "node_modules/vite/bin/vite.js",
          "build",
          "--mode",
          "public",
          "--outDir",
          out,
          "--logLevel",
          "error",
        ],
        { stdio: "ignore" },
      );
      const bundle = readdirSync(path.join(out, "assets"))
        .filter((f) => f.endsWith(".js"))
        .map((f) => readFileSync(path.join(out, "assets", f), "utf8"))
        .join("\n");
      for (const owner of [
        "/api/session",
        "/api/corrections",
        "/api/incidents/merge",
        "/api/incidents/split",
        "/api/jobs/",
        "/api/export",
        "/api/events",
        "/api/cameras",
        "/api/news-signals",
        "/api/incidents/link",
        "EventSource",
      ])
        assert(!bundle.includes(owner), owner);
      const { files } = await buildPublicSnapshot({ fetch: upstream() });
      const base = "/world-watch/";
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
      };
      site.on("request", (req, res) => {
        const pathname = new URL(req.url!, "http://site").pathname;
        const name = pathname.slice(base.length) || "index.html";
        const built = path.join(out, name);
        const body = !pathname.startsWith(base)
          ? undefined
          : name.startsWith("data/")
            ? files.get(name.slice(5))
            : existsSync(built)
              ? readFileSync(built)
              : undefined;
        if (body === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": types[path.extname(name)] ?? "application/json",
        });
        res.end(body);
      });
      await new Promise<void>((resolve) =>
        site.listen(0, "127.0.0.1", resolve),
      );
      const origin = `http://127.0.0.1:${(site.address() as any).port}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const requests: { method: string; url: string; auth: boolean }[] = [];
      page.on("request", (r: any) =>
        requests.push({
          method: r.method(),
          url: r.url(),
          auth: "authorization" in r.headers() || "cookie" in r.headers(),
        }),
      );
      await page.route("**/*", (route: any) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      await page.goto(origin + base + "?hours=0");
      await page.waitForSelector(".feed-item");
      assert.equal(
        await page.locator(".feed-item").count(),
        situations(JSON.parse(files.get("incidents.json")!).incidents).length,
      );
      assert.match(
        await page.locator(".public-banner").innerText(),
        /Public demo\. Live public sources\. Some layers and analysis disabled\./,
      );
      assert.match(
        await page.locator(".health-pill").innerText(),
        /Public snapshot/,
      );
      assert.equal(
        await page.getByLabel("Switch incoming reports and incidents").count(),
        0,
      );
      assert.equal(await page.getByLabel("Enable sound").count(), 0);
      await page.locator(".feed-item").first().click();
      await page.waitForSelector(".detail h1");
      const detail = await page.locator(".detail").innerText();
      for (const hidden of ["Private notes", "Incident reconstruction", "JSON"])
        assert(!detail.includes(hidden), hidden);
      await page.keyboard.press("Escape");
      await page.getByLabel("Contextual controls").click();
      const controls = await page.locator(".panel-content").innerText();
      for (const hidden of [
        "Private areas",
        "Replay",
        "Public cameras",
        "GeoJSON",
        "Sound volume",
      ])
        assert(!controls.includes(hidden), hidden);
      // Every source the snapshot just read is on schedule, judged against the ten-minute rebuild.
      assert.match(
        await page.locator(".health-pill").innerText(),
        new RegExp(`${PUBLIC_SOURCES.length}/${PUBLIC_SOURCES.length} sources fresh`),
      );
      for (const s of PUBLIC_SOURCES)
        assert.match(
          await page
            .locator(".coverage .coverage-list li", { hasText: s.name })
            .locator(".coverage-chip")
            .innerText(),
          /^(Observed|Quiet)$/,
          s.id,
        );
      await page.getByLabel("Satellite thermal detections").check();
      await page
        .getByRole("button", { name: "Explore geospatial context" })
        .click();
      await page.getByText("detections worldwide").first().waitFor();
      await page.locator(".public-banner button").click();
      const sources = await page.locator(".panel-content").innerText();
      for (const s of PUBLIC_SOURCES)
        assert(sources.includes(s.rights.attribution), s.id);
      const local = requests.filter((r) => r.url.startsWith(origin));
      assert(local.some((r) => r.url.includes("/data/geospatial.json")));
      assert(requests.every((r) => r.method === "GET" && !r.auth));
      assert(!local.some((r) => new URL(r.url).pathname.includes("/api/")));
    } finally {
      await browser?.close();
      site.close();
      rmSync(out, { recursive: true, force: true });
    }
  },
);
