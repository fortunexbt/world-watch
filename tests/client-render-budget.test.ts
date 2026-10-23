import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

// Counts React feed-row renders through the DevTools hook and GeoJSON loads ("LD", one per
// setData) through the map worker's messages, on the real map.
const instrument = `
  const perf = (window.__perf = { rows: 0, loads: 0 });
  let seen = new WeakSet();
  const walk = (fiber, next) => {
    for (let f = fiber; f; f = f.sibling) {
      next.add(f);
      const a = f.alternate;
      if (!seen.has(f) && f.type && f.type.name === "FeedItem" && (!a || a.memoizedProps !== f.memoizedProps)) perf.rows++;
      if (f.child) walk(f.child, next);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1; }, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_, root) { const next = new WeakSet(); walk(root.current, next); seen = next; },
  };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (data, ...rest) { if (data && data.type === "LD") perf.loads++; return post.call(this, data, ...rest); };
  window.__streams = [];
  window.EventSource = class {
    constructor() { this.listeners = {}; this.closed = false; window.__streams.push(this); setTimeout(() => this.onopen?.(), 0); }
    addEventListener(k, v) { (this.listeners[k] ??= []).push(v); }
    close() { this.closed = true; }
    emit(k, data, cursor) { for (const f of this.listeners[k] ?? []) f(new MessageEvent(k, { data: JSON.stringify(data), lastEventId: String(cursor) })); }
  };
`;

test(
  "a pan sends no map data and re-renders no feed row; an SSE arrival renders one row and one map source, without a read when it carries its view",
  { timeout: 90000 },
  async () => {
    const server = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5194", "--strictPort"],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:5194")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript({ content: instrument });
      const now = new Date().toISOString();
      const incident = (n: number) => ({
        id: "fixture-" + n,
        version: 1,
        headline: "Fixture " + n,
        summary_en: "Isolated fixture.",
        summary_it: null,
        activity: "earthquake",
        impact: "minor",
        evidence_status: "official_advisory",
        location: { name: "Fixture place", country: null, lon: (n * 7) % 340 - 170, lat: (n * 3) % 120 - 60, accuracy: "point", radius_km: 8 },
        event_start: now,
        event_end: null,
        published_at: null,
        ingested_at: now,
        analyzed_at: null,
        updated_at: now,
        expires_at: null,
        claims: [],
        reports: [],
        history: [],
        review_needed: false,
        cancelled: false,
      });
      const incidents = Array.from({ length: 300 }, (_, n) => incident(n));
      let details = 0;
      await page.route("**/*", async (route: any) => {
        const u = new URL(route.request().url());
        if (u.origin !== "http://127.0.0.1:5194") return route.abort();
        if (u.pathname === "/api/snapshot")
          return route.fulfill({ json: { incidents, incoming: [], sources: [], status: {}, cursor: "1" } });
        if (u.pathname.startsWith("/api/incidents/")) details++;
        if (u.pathname === "/api/incidents/fixture-arrival") return route.fulfill({ json: { ...incident(1000), id: "fixture-arrival", headline: "Fixture arrival" } });
        if (u.pathname.startsWith("/api/")) return route.fulfill({ json: { current: null, pending: false } });
        return route.continue();
      });
      await page.goto("http://127.0.0.1:5194");
      await page.getByRole("heading", { name: "Fixture 299", exact: true }).waitFor();
      await page.waitForSelector('.map[data-boundaries="loaded"]');
      await page.waitForTimeout(1000);
      const counts = () => page.evaluate(() => ({ ...(window as any).__perf }));

      const before = await counts();
      // The world frame cannot pan, so zoom in and then drag; each settled view reaches App as a bbox.
      const bounds = () => page.locator(".map").getAttribute("data-map-bounds");
      const moved = async (act: () => Promise<void>) => {
        const prior = await bounds();
        await act();
        await page.waitForFunction((b: string | null) => document.querySelector(".map")?.getAttribute("data-map-bounds") !== b, prior);
      };
      await page.mouse.move(900, 450);
      await moved(() => page.mouse.wheel(0, -500));
      await moved(async () => {
        await page.mouse.down();
        for (let s = 1; s <= 20; s++) await page.mouse.move(900 - s * 15, 450 + s * 3);
        await page.mouse.up();
      });
      await page.waitForTimeout(800);
      const panned = await counts();
      assert.equal(panned.loads - before.loads, 0, "a pan sends no source data to the map worker");
      assert.equal(panned.rows - before.rows, 0, "a pan re-renders no feed row");

      await page.evaluate(() => (window as any).__streams.at(-1).emit("incident.created", { incident_id: "fixture-arrival", version: 1, catchup: false }, 2));
      await page.getByRole("heading", { name: "Fixture arrival", exact: true }).waitFor();
      await page.waitForTimeout(800);
      const arrived = await counts();
      assert.equal(arrived.rows - panned.rows, 1, "only the new row renders");
      assert.equal(arrived.loads - panned.loads, 1, "only the incident source is sent");
      assert.equal(details, 1, "an event without its view is read back");

      // An event that carries its view needs no read.
      const carried = { ...incident(1001), id: "fixture-carried", headline: "Fixture carried" };
      await page.evaluate((view: any) => (window as any).__streams.at(-1).emit("incident.created", { incident_id: view.id, version: 1, catchup: false, incident: view }, 3), carried);
      await page.getByRole("heading", { name: "Fixture carried", exact: true }).waitFor();
      await page.waitForTimeout(500);
      assert.equal(details, 1, "the carried view is used as it is");
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
