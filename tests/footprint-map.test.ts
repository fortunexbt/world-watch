import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { parseNws } from "../src/collector/adapters/nws.js";
import { parseShakeMapContours } from "../src/collector/adapters/usgs.js";
import { parseGdacsGeometry } from "../src/collector/adapters/gdacs.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { listView } from "../src/shared/view.js";
import type { Footprint } from "../src/shared/footprint.js";

// Counts GeoJSON loads ("LD", one per setData) by source through the map worker's messages.
const instrument = `
  window.__loads = {};
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (data, ...rest) {
    if (data && data.type === "LD") { const id = data.data && data.data.source; window.__loads[id] = (window.__loads[id] || 0) + 1; }
    return post.call(this, data, ...rest);
  };
  window.__streams = [];
  window.EventSource = class {
    constructor() { this.listeners = {}; window.__streams.push(this); setTimeout(() => this.onopen?.(), 0); }
    addEventListener(k, v) { (this.listeners[k] ??= []).push(v); }
    close() {}
    emit(k, data, cursor) { for (const f of this.listeners[k] ?? []) f(new MessageEvent(k, { data: JSON.stringify(data), lastEventId: String(cursor) })); }
  };
`;
const fixture = (name: string) =>
  JSON.parse(readFileSync("tests/fixtures/" + name, "utf8"));
const nws = parseNws(
  sourceRegistry.find((s) => s.id === "us-nws-warnings")!,
  fixture("nws-alerts.json"),
);
const contours = fixture("usgs-cont-mmi.json");

test(
  "footprints draw under the markers by role, load once, follow the selected incident's detail and name themselves in the legend",
  { timeout: 90000 },
  async () => {
    const server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        "5197",
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:5197")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({ headless: true });
      const now = new Date().toISOString();
      const record = (
        id: string,
        activity: string,
        impact: string,
        lon: number,
        lat: number,
        footprint?: Footprint,
      ) => ({
        id,
        version: 1,
        headline: "Fixture " + id,
        summary_en: "",
        summary_it: null,
        activity,
        impact,
        evidence_status: "official_advisory",
        location: {
          name: "Fixture place",
          country: null,
          lon,
          lat,
          accuracy: activity === "earthquake" ? "point" : "area",
          radius_km: 300,
        },
        ...(footprint ? { footprint } : {}),
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
      const warning = nws[0];
      const full = [
        record(
          "warning",
          "severe_weather",
          "severe",
          warning.source_geo!.lon,
          warning.source_geo!.lat,
          warning.footprint,
        ),
        record(
          "quake",
          "earthquake",
          "severe",
          93.8,
          32.1,
          parseShakeMapContours(contours, "https://earthquake.usgs.gov/c")!,
        ),
        record(
          "cyclone",
          "tropical_cyclone",
          "severe",
          145,
          15,
          parseGdacsGeometry(
            fixture("gdacs-geometry-tc.json"),
            "https://www.gdacs.org/g",
          )!,
        ),
        record("plain", "earthquake", "minor", -70, -30),
      ];
      const open = async (incidents: unknown[]) => {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
        });
        const errors: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(String(e)));
        await page.addInitScript({ content: instrument });
        await page.route("**/*", async (route: any) => {
          const u = new URL(route.request().url());
          if (u.origin !== "http://127.0.0.1:5197") return route.abort();
          if (u.pathname === "/api/snapshot")
            return route.fulfill({
              json: {
                incidents,
                incoming: [],
                sources: [],
                status: {},
                cursor: "1",
              },
            });
          const detail = full.find(
            (i) => u.pathname === "/api/incidents/" + i.id,
          );
          if (detail) return route.fulfill({ json: detail });
          if (u.pathname.startsWith("/api/"))
            return route.fulfill({ json: { current: null, pending: false } });
          return route.continue();
        });
        await page.goto("http://127.0.0.1:5197");
        await page
          .getByRole("heading", { name: "Fixture warning", exact: true })
          .waitFor();
        await page.waitForSelector('.map[data-boundaries="loaded"]');
        await page.waitForTimeout(1200);
        return { page, errors };
      };
      // The snapshot carries list views, so only display copies are drawn at first.
      const listed = full.map((i) => listView(i as any));
      assert.ok(listed.every((i: any) => !i.footprint || !i.footprint.detail));
      const { page, errors } = await open(listed);
      assert.deepEqual(errors, []);
      assert.equal(
        await page.locator(".map").getAttribute("data-map-error"),
        null,
      );
      const loads = () => page.evaluate(() => ({ ...(window as any).__loads }));
      const first = await loads();
      // Each source loads once empty when it is added, then once with the snapshot.
      assert.equal(first.footprints, 2, "one footprint load for the snapshot");
      const legend = page.getByRole("group", { name: "Map legend" });
      for (const label of [
        "issuer warning area",
        "modelled wind area",
        "estimated shaking (MMI)",
      ])
        assert.ok(
          await legend.getByText(label, { exact: true }).isVisible(),
          label,
        );

      // A pan moves the map without resending either source.
      await page.mouse.move(900, 450);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(600);
      await page.mouse.down();
      for (let s = 1; s <= 10; s++) await page.mouse.move(900 - s * 20, 450);
      await page.mouse.up();
      await page.waitForTimeout(800);
      assert.deepEqual(await loads(), first, "a pan sends no source data");

      // Selecting the warning reads its detail, whose finer footprint replaces the display copy once.
      await page.locator('[data-incident-id="warning"]').click();
      await page.waitForTimeout(1200);
      const selected = await loads();
      assert.equal(selected.footprints, 3);

      // Footprints add visible map pixels: compare the same incidents without them against a page
      // whose footprints arrive afterwards as SSE updates, each patched in by itself.
      const hide =
        ".topbar,.rolling-brief,.panel,.legend,.health-pill,.maplibregl-control-container,.detail{visibility:hidden!important}";
      const shot = async (p: any) => {
        await p.addStyleTag({ content: hide });
        await p.waitForTimeout(300);
        return (await p.screenshot()).toString("base64");
      };
      const stripped = listed.map(({ footprint, ...i }: any) => i);
      const fresh = await open(stripped);
      const bare = await open(stripped);
      const patched = await fresh.page.evaluate(
        () => (window as any).__loads.footprints,
      );
      for (const [n, view] of listed.filter((i: any) => i.footprint).entries())
        await fresh.page.evaluate(
          ([v, cursor]: any) =>
            (window as any).__streams
              .at(-1)
              .emit(
                "incident.updated",
                {
                  incident_id: v.id,
                  version: 2,
                  catchup: false,
                  incident: { ...v, version: 2 },
                },
                cursor,
              ),
          [view, n + 2],
        );
      await fresh.page.waitForTimeout(1200);
      assert.equal(
        (await fresh.page.evaluate(() => (window as any).__loads.footprints)) -
          patched,
        3,
        "one patch per arriving footprint",
      );
      const [withShot, bareShot] = [
        await shot(fresh.page),
        await shot(bare.page),
      ];
      const changed = await page.evaluate(
        async (shots: string[]) => {
          const data: Uint8ClampedArray[] = [];
          for (const shot of shots) {
            const img = new Image();
            img.src = "data:image/png;base64," + shot;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            data.push(ctx.getImageData(0, 0, img.width, img.height).data);
          }
          const [x, y] = data;
          let n = 0;
          for (let i = 0; i < x.length; i += 4)
            if (
              Math.abs(x[i] - y[i]) +
                Math.abs(x[i + 1] - y[i + 1]) +
                Math.abs(x[i + 2] - y[i + 2]) >
              12
            )
              n++;
          return n;
        },
        [withShot, bareShot],
      );
      assert.ok(
        changed > 1500,
        `${changed} pixels differ with footprints drawn`,
      );
      assert.deepEqual([...fresh.errors, ...bare.errors], []);
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
