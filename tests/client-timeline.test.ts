import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { readView } from "../src/client/permalink.js";

const ORIGIN = "http://127.0.0.1:5204",
  HOUR = 3600000,
  DAY = 24 * HOUR;
const view = (id: string, version: number, headline: string, lon: number, lat: number) => ({
  id,
  version,
  headline,
  summary_en: "Fixture.",
  summary_it: null,
  activity: "earthquake",
  impact: "significant",
  evidence_status: "official_advisory",
  location: { name: headline, country: null, lon, lat, accuracy: "point", radius_km: 0 },
  event_start: new Date(Date.now() - 2 * DAY).toISOString(),
  event_end: null,
  published_at: null,
  ingested_at: null,
  analyzed_at: null,
  updated_at: new Date(Date.now() - 2 * DAY).toISOString(),
  expires_at: null,
  claims: [],
  reports: [],
  review_needed: false,
  cancelled: false,
});

test(
  "the time control scrubs, steps, plays and returns to live, and every view state round-trips through the link",
  { timeout: 90000 },
  async () => {
    const server = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5204", "--strictPort"],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch(ORIGIN)).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
      const now = Date.now(),
        historyFrom = new Date(now - 3 * DAY).toISOString();
      const requests: URL[] = [];
      await context.addInitScript({
        content: `window.EventSource=class{constructor(){}addEventListener(){}close(){}};`,
      });
      await context.route("**/*", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        requests.push(url);
        const at = url.searchParams.get("at");
        if (url.pathname === "/api/snapshot")
          return route.fulfill({
            json: {
              // Before its correction the quake sat in Paris; a later record was not yet known.
              incidents: at
                ? [view("a", 1, "Quake first located near Paris", 2.35, 48.85)]
                : [view("a", 2, "Quake relocated to Tokyo", 139.7, 35.7), view("b", 1, "Later quake", 12.5, 41.9)],
              incoming: [],
              sources: [],
              status: {},
              cursor: "1",
              historical_at: at,
              history_from: historyFrom,
              limited: false,
            },
          });
        if (url.pathname === "/api/brief") return route.fulfill({ json: { current: null, pending: false, updated_at: null } });
        if (url.pathname === "/api/cameras") return route.fulfill({ json: { cameras: [] } });
        const id = url.pathname.match(/^\/api\/incidents\/(.+)$/)?.[1];
        if (id === "a")
          return route.fulfill({
            json: at
              ? { ...view("a", 1, "Quake first located near Paris", 2.35, 48.85), history: [] }
              : { ...view("a", 2, "Quake relocated to Tokyo", 139.7, 35.7), history: [] },
          });
        if (id === "b" && !at) return route.fulfill({ json: { ...view("b", 1, "Later quake", 12.5, 41.9), history: [] } });
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      });
      const page = await context.newPage();
      const snapshots = () => requests.filter((u) => u.pathname === "/api/snapshot");
      const nextAt = async (expected: number) => {
        const iso = new Date(expected).toISOString();
        for (let n = 0; n < 60 && !snapshots().some((u) => u.searchParams.get("at") === iso); n++)
          await page.waitForTimeout(100);
        assert.ok(snapshots().some((u) => u.searchParams.get("at") === iso), `a snapshot at ${iso}: ${snapshots().map((u) => u.searchParams.get("at")).join(" ")}`);
      };

      // A link carrying every part of a view: replay time, window, filter, search, selection, map, scope, layers and imagery.
      const at = new Date(now - 26 * HOUR).setMinutes(0, 0, 0);
      const opened =
        `?hours=24&filter=hazards&q=quake&incident=a&layer=thermal,density&imagery=modis-true-colour&imagery_day=2026-10-20` +
        `&map=3/48.85/2.35&scope=map&at=${new Date(at).toISOString()}`;
      await page.goto(ORIGIN + "/" + opened);
      const bar = page.locator(".time-bar");
      await bar.waitFor();
      assert.match(await bar.innerText(), /Showing what World Watch knew by this time, not when events happened/);
      await page.getByRole("heading", { name: "Quake first located near Paris" }).waitFor();
      await page.waitForFunction(() => document.querySelector(".map")?.getAttribute("data-map-bounds"));
      await page.waitForTimeout(400);
      assert.deepEqual(readView(new URL(page.url()).search), readView(opened));
      const replayed = snapshots().findLast((u) => u.searchParams.has("bbox"))!;
      assert.equal(replayed.searchParams.get("at"), new Date(at).toISOString());
      assert.equal(replayed.searchParams.get("hours"), "24");
      assert.equal(replayed.searchParams.get("q"), "quake");
      assert.ok(requests.some((u) => u.pathname === "/api/incidents/a" && u.searchParams.get("at") === new Date(at).toISOString()));
      assert.ok(requests.some((u) => u.pathname === "/api/brief" && u.searchParams.get("at") === new Date(at).toISOString()));
      // Live-only layers stay hidden and unread, and the feed says so.
      assert.ok(!requests.some((u) => u.pathname === "/api/geospatial"));
      await page.getByRole("button", { name: "Back to activity" }).click();
      const strip = page.locator(".historical");
      assert.match(await strip.innerText(), /As known at/);
      assert.match(await strip.innerText(), /Not kept as history, so hidden: Satellite thermal detections\./);

      // Keyboard: one step, a day, the oldest and newest stops, each settling into one read.
      const slider = page.getByLabel("Known by");
      await slider.focus();
      await page.keyboard.press("ArrowLeft");
      await nextAt(at - HOUR);
      await page.keyboard.press("PageDown");
      await nextAt(at - HOUR - DAY);
      assert.equal(new URL(page.url()).searchParams.get("at"), new Date(at - HOUR - DAY).toISOString());
      await page.keyboard.press("Home");
      const oldest = Number(await slider.getAttribute("min"));
      assert.ok(oldest <= Date.parse(historyFrom) && Date.parse(historyFrom) - oldest < HOUR);
      await nextAt(oldest);
      // A coarser step snaps to whole local days.
      await page.getByLabel("Step").selectOption({ label: "1 day" });
      await slider.focus();
      await page.keyboard.press("ArrowRight");
      const midnight = Number(await slider.getAttribute("value"));
      assert.equal(new Date(midnight).getHours(), 0);
      await nextAt(midnight);
      await page.getByLabel("Step").selectOption({ label: "1 hour" });

      // Play advances one step at a time, each after the previous view arrived, until paused.
      await page.getByRole("button", { name: "Play" }).click();
      await nextAt(midnight + HOUR);
      await nextAt(midnight + 2 * HOUR);
      await page.getByRole("button", { name: "Pause" }).click();
      const played = snapshots().length;
      await page.waitForTimeout(1600);
      assert.equal(snapshots().length, played);

      // Copy link puts this exact view on the clipboard.
      await bar.getByRole("button", { name: "Copy link" }).click();
      await bar.getByText("Link copied").waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), page.url());

      // Returning to live drops the time everywhere.
      await bar.getByRole("button", { name: "Return to live" }).click();
      await page.locator(".feed-item", { hasText: "Quake relocated to Tokyo" }).waitFor();
      assert.equal(await bar.count(), 0);
      assert.equal(await strip.count(), 0);
      assert.ok(!new URL(page.url()).searchParams.has("at"));
      assert.ok(!snapshots().at(-1)!.searchParams.has("at"));

      // A link made before the time control opens live, with its incident and camera layer.
      requests.length = 0;
      await page.goto(ORIGIN + "/?hours=168&incident=b&layer=cameras");
      await page.getByRole("heading", { name: "Later quake" }).waitFor();
      assert.equal(await page.locator(".time-bar").count(), 0);
      assert.ok(snapshots().every((u) => !u.searchParams.has("at")));
      const kept = new URL(page.url()).searchParams;
      assert.equal(kept.get("incident"), "b");
      assert.equal(kept.get("layer"), "cameras");
      // The incident was not yet known at an earlier time, and the panel says so.
      await page.getByRole("button", { name: "Earlier time" }).click();
      await page.getByLabel("Known by").focus();
      await page.keyboard.press("Home");
      await page.getByText("The selected incident was not yet known at this time.").waitFor();
    } finally {
      await browser?.close();
      server.kill();
    }
  },
);
