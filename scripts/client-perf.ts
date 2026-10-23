// Offline client performance harness. Builds the client into a throwaway
// directory, serves it on an ephemeral local port and answers every API call
// in Playwright with synthetic data from scripts/synthetic.ts. External hosts
// are blocked, so the map draws its bundled Natural Earth boundaries rather
// than vector tiles. Chromium runs headless on the real GPU (ANGLE Metal on
// macOS); WebKit, when installed, gives rAF and render counts only.
//
//   npm run perf:client -- --markers=1000,5000 --runs=3 --out=/tmp/ww-client.json
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { FIRMS_SENSORS, CEMS_URL, getGeospatialCatalog, getThermalTile } from "../src/server/geospatial.js";
import { burst, thermalFiles, views } from "./synthetic.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "1"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const markers = String(args.markers ?? "1000,5000").split(",").map(Number);
const runs = Number(args.runs ?? 3),
  burstSize = Number(args.burst ?? 100),
  cpu = Number(args.cpu ?? 1),
  browsers = String(args.browser ?? "chromium,webkit").split(",");
const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "world-watch-client-"));
const dist = path.join(temp, "dist");
const log = (...v: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...v);
const load = () => Number(loadavg()[0].toFixed(1));

// Counters the page keeps for the harness: React commits through the DevTools hook (component
// renders and reconciled host elements only when `walk` is on, since the walk costs script time),
// rAF intervals, long tasks, long animation frames and messages to MapLibre's workers by type
// ("LD" is a GeoJSON source's loadData, one per setData).
const instrument = `
  const perf = (window.__perf = { commits: 0, renders: 0, elements: 0, walk: false, frames: [], recording: false, loaf: [], longtasks: [], messages: {} });
  let seen = new WeakSet();
  const walk = (fiber, next) => {
    for (let f = fiber; f; f = f.sibling) {
      next.add(f);
      if (!seen.has(f) && [0, 1, 5, 11, 14, 15].includes(f.tag)) {
        const a = f.alternate;
        if (!a || a.memoizedProps !== f.memoizedProps || a.memoizedState !== f.memoizedState) f.tag === 5 ? perf.elements++ : perf.renders++;
      }
      if (f.child) walk(f.child, next);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1; }, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_, root) { perf.commits++; if (perf.walk) { const next = new WeakSet(); walk(root.current, next); seen = next; } },
  };
  let last = 0;
  const tick = (t) => { if (perf.recording && last) perf.frames.push(t - last); last = perf.recording ? t : 0; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  for (const [type, list] of [["long-animation-frame", perf.loaf], ["longtask", perf.longtasks]])
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) list.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration ?? 0 }); }).observe({ type, buffered: true }); } catch {}
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (data, ...rest) { const k = data && data.type || "other"; perf.messages[k] = (perf.messages[k] || 0) + 1; return post.call(this, data, ...rest); };
  window.__hidden = false; window.__streams = [];
  window.EventSource = class {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; window.__streams.push(this); setTimeout(() => this.onopen?.(), 0); }
    addEventListener(k, v) { (this.listeners[k] ??= []).push(v); }
    close() { this.closed = true; }
    emit(k, data, cursor) { for (const f of this.listeners[k] ?? []) f(new MessageEvent(k, { data: JSON.stringify(data), lastEventId: String(cursor) })); }
  };
`;

const percentile = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
};
const median = (v: number[]) => percentile(v, 50);
const r1 = (v: number) => Math.round(v * 10) / 10;

let server: ReturnType<typeof createServer> | undefined;
const opened: Browser[] = [];
try {
  log("building client");
  execFileSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: root, stdio: "inherit" });
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/geo+json", ".svg": "image/svg+xml", ".png": "image/png" };
  server = createServer((req, res) => {
    const pathname = new URL(req.url!, "http://x").pathname;
    let file = path.join(dist, path.normalize(pathname));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;

  log("building synthetic data");
  const all = await views(Math.max(...markers), 7);
  const thermal = thermalFiles(200000, 7);
  const firms = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const k = FIRMS_SENSORS.findIndex((s) => s.url === url);
    if (k >= 0) return new Response(thermal[k]);
    if (url === CEMS_URL) return Response.json({ results: [] });
    throw Error("blocked " + url);
  }) as typeof fetch;
  const catalog = JSON.stringify(await getGeospatialCatalog(undefined, firms));
  const fresh = new Map<string, unknown>();
  const results: Record<string, unknown>[] = [];
  let open: Page | undefined;

  async function scene(browserName: string, browser: Browser, count: number) {
    const incidents = all.slice(0, count);
    const byId = new Map(incidents.map((i) => [i.id, i]));
    const snapshot = JSON.stringify({ incidents, incoming: [], sources: [], status: { worker_state: "not_seen" }, cursor: "100", limited: count >= 1000 });
    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    open = page;
    await page.addInitScript({ content: instrument });
    await page.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/api/snapshot") return route.fulfill({ contentType: "application/json", body: snapshot });
      if (u.pathname === "/api/brief") return route.fulfill({ json: { current: null, pending: false } });
      if (u.pathname === "/api/geospatial") return route.fulfill({ contentType: "application/json", body: catalog });
      const tile = u.pathname.match(/^\/api\/thermal\/\w+\/(\d+)\/(\d+)\/(\d+)$/);
      if (tile) {
        const { tile: data } = await getThermalTile(+tile[1], +tile[2], +tile[3], firms);
        return data ? route.fulfill({ contentType: "application/x-protobuf", body: Buffer.from(data) }) : route.fulfill({ status: 204 });
      }
      if (u.pathname.startsWith("/api/incidents/")) {
        const id = decodeURIComponent(u.pathname.slice(15));
        const view = fresh.get(id) ?? byId.get(id);
        return view ? route.fulfill({ json: view }) : route.fulfill({ status: 404, json: { error: "not_found" } });
      }
      if (u.pathname.startsWith("/api/")) return route.fulfill({ status: 404, json: { error: "not_found" } });
      if (u.origin !== origin) return route.abort();
      return route.continue();
    });
    const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send("Performance.enable");
      if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    }
    const metrics = async () => {
      if (!cdp) return {} as Record<string, number>;
      const { metrics } = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(metrics.map((m: any) => [m.name, m.value])) as Record<string, number>;
    };
    const delta = (a: Record<string, number>, b: Record<string, number>) =>
      cdp
        ? {
            task_ms: r1((b.TaskDuration - a.TaskDuration) * 1000),
            script_ms: r1((b.ScriptDuration - a.ScriptDuration) * 1000),
            layout_ms: r1((b.LayoutDuration - a.LayoutDuration) * 1000),
            style_ms: r1((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000),
            layouts: b.LayoutCount - a.LayoutCount,
            style_recalcs: b.RecalcStyleCount - a.RecalcStyleCount,
          }
        : {};
    const counters = () => page.evaluate(() => { const p = (window as any).__perf; return { commits: p.commits, renders: p.renders, elements: p.elements, messages: { ...p.messages }, loaf: p.loaf.length, longtasks: p.longtasks.length }; });
    const settle = async (quiet = 600) => {
      for (let last = -1, stable = 0; stable < quiet; ) {
        const now = await page.evaluate(() => (window as any).__perf.commits);
        stable = now === last ? stable + 100 : 0;
        last = now;
        await page.waitForTimeout(100);
      }
    };
    const loadData = (m: Record<string, number>) => Object.entries(m).filter(([k]) => k === "LD").reduce((n, [, v]) => n + v, 0);

    const t0 = Date.now();
    await page.goto(origin + "/?hours=168");
    await page.locator(".feed-item").first().waitFor({ timeout: 120000 });
    const firstItem = await page.evaluate(() => performance.now());
    await page.locator('.map[data-boundaries="loaded"]').waitFor({ timeout: 120000 });
    await settle(1000);
    const loaded = await page.evaluate(() => {
      const p = (window as any).__perf;
      return {
        first_feed_item_ms: 0,
        ready_ms: performance.now(),
        long_tasks: p.longtasks.length,
        long_task_ms: p.longtasks.reduce((n: number, e: any) => n + e.duration, 0),
        loaf_blocking_ms: p.loaf.reduce((n: number, e: any) => n + e.blocking, 0),
        commits: p.commits,
        dom_nodes: document.getElementsByTagName("*").length,
        heap_mb: (performance as any).memory ? (performance as any).memory.usedJSHeapSize / 1048576 : null,
      };
    });
    loaded.first_feed_item_ms = firstItem;
    const m0 = await metrics();
    const out: Record<string, any> = { browser: browserName, markers: count, cpu_throttle: cpu, load_avg: load(), wall_load_s: (Date.now() - t0) / 1000, load: { ...loaded, ready_ms: r1(loaded.ready_ms), first_feed_item_ms: r1(firstItem), long_task_ms: r1(loaded.long_task_ms), loaf_blocking_ms: r1(loaded.loaf_blocking_ms), heap_mb: loaded.heap_mb && r1(loaded.heap_mb), task_ms: m0.TaskDuration ? r1(m0.TaskDuration * 1000) : undefined } };

    // Pan and zoom with real mouse and wheel input over the map, outside the side panel.
    const gesture = async (name: string, act: () => Promise<void>) => {
      await settle();
      const before = await counters(),
        mBefore = await metrics();
      await page.evaluate(() => { const p = (window as any).__perf; p.frames = []; p.loaf.length = 0; p.longtasks.length = 0; p.recording = true; });
      await act();
      await page.waitForTimeout(700);
      await page.evaluate(() => ((window as any).__perf.recording = false));
      await settle();
      const after = await counters(),
        mAfter = await metrics();
      const frames: number[] = await page.evaluate(() => (window as any).__perf.frames);
      const loaf = await page.evaluate(() => (window as any).__perf.loaf);
      out[name] = {
        frames: frames.length,
        frame_p50_ms: r1(median(frames)),
        frame_p95_ms: r1(percentile(frames, 95)),
        frame_p99_ms: r1(percentile(frames, 99)),
        frame_max_ms: r1(Math.max(0, ...frames)),
        over_33ms: frames.filter((f) => f > 33.4).length,
        loaf_count: loaf.length,
        loaf_blocking_ms: r1(loaf.reduce((n: number, e: any) => n + e.blocking, 0)),
        commits: after.commits - before.commits,
        map_data_updates: loadData(after.messages) - loadData(before.messages),
        ...delta(mBefore, mAfter),
      };
    };
    const drag = async () => {
      for (const [dx, dy] of [[-420, 60], [380, -120], [120, 90]]) {
        await page.mouse.move(900, 450);
        await page.mouse.down();
        for (let s = 1; s <= 30; s++) await page.mouse.move(900 + (dx * s) / 30, 450 + (dy * s) / 30);
        await page.mouse.up();
        await page.waitForTimeout(250);
      }
    };
    const zoom = async () => {
      await page.mouse.move(1000, 420);
      for (const dy of [-240, -240, -240, 240, 240, 240]) {
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(120);
      }
    };
    await gesture("pan", drag);
    await gesture("zoom", zoom);
    await page.getByRole("button", { name: "Contextual controls", exact: true }).click();
    const geospatial = page.waitForResponse((r) => r.url().includes("/api/geospatial"));
    await page.getByLabel("Satellite thermal detections").check();
    await geospatial;
    await page.waitForTimeout(1500);
    await gesture("pan with every thermal detection", drag);

    // An SSE burst of new incidents, each followed by its detail read as the client does, with
    // the feed showing and the pointer over the map, so the feed is live rather than buffered.
    await page.keyboard.press("Escape");
    await page.locator(".feed-item").first().waitFor();
    await page.mouse.move(1000, 420);
    await settle();
    const before = await counters(),
      mBefore = await metrics();
    const started = Date.now();
    const arrivals = burst(burstSize, count, Date.now());
    const created = arrivals.map((o, k) => ({ ...all[k % all.length], id: `burst-${count}-${k}`, version: 1, headline: o.title, updated_at: new Date().toISOString() }));
    for (const v of created) fresh.set(v.id, v);
    for (let k = 0; k < created.length; k++)
      await page.evaluate(({ id, cursor }) => (window as any).__streams.filter((s: any) => !s.closed).at(-1).emit("incident.created", { incident_id: id, version: 1, catchup: false }, cursor), { id: created[k].id, cursor: 1000 + k });
    await settle();
    const after = await counters(),
      mAfter = await metrics();
    out["sse burst"] = {
      events: created.length,
      wall_ms: Date.now() - started,
      commits: after.commits - before.commits,
      map_data_updates: loadData(after.messages) - loadData(before.messages),
      ...delta(mBefore, mAfter),
    };

    // Component renders for the same burst, counted with the fiber walk on.
    await page.evaluate(() => ((window as any).__perf.walk = true));
    await settle();
    const r0 = await counters();
    const again = created.map((v) => ({ ...v, id: v.id + "-b" }));
    for (const v of again) fresh.set(v.id, v);
    for (let k = 0; k < again.length; k++)
      await page.evaluate(({ id, cursor }) => (window as any).__streams.filter((s: any) => !s.closed).at(-1).emit("incident.created", { incident_id: id, version: 1, catchup: false }, cursor), { id: again[k].id, cursor: 5000 + k });
    await settle();
    const r1_ = await counters();
    out["sse burst"].component_renders = r1_.renders - r0.renders;
    out["sse burst"].elements_reconciled = r1_.elements - r0.elements;
    const m = await metrics();
    out.heap_mb_end = cdp ? r1(m.JSHeapUsedSize / 1048576) : null;
    out.messages = r1_.messages;
    await page.close();
    return out;
  }

  for (const name of browsers) {
    const type = name === "webkit" ? webkit : chromium;
    let browser: Browser;
    try {
      browser = await type.launch(name === "chromium" ? { headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] } : { headless: true });
    } catch (error) {
      log(`${name} unavailable: ${String(error).split("\n")[0]}`);
      continue;
    }
    opened.push(browser);
    for (let run = 0; run < runs; run++)
      for (const count of markers) {
        log(`${name} ${count} markers, run ${run + 1}`);
        // A crashed or stalled page is a result too: record it and keep going.
        results.push({
          run: run + 1,
          ...(await scene(name, browser, count).catch(async (error) => {
            await open?.close().catch(() => {});
            return { browser: name, markers: count, error: String(error).split("\n")[0] };
          })),
        });
      }
    await browser.close();
  }
  const report = { markers, runs, burst: burstSize, cpu_throttle: cpu, results };
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const b of opened) await b.close().catch(() => {});
  server?.close();
  await rm(temp, { recursive: true, force: true });
}
