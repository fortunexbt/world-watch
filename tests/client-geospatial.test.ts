import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { viewportBounds } from "../src/client/bounds.js";
import { translate } from "../src/client/locale.js";
import { parseBbox } from "../src/server/geospatial.js";
test("viewport bounds are plain decimals the geospatial API accepts", () => {
  assert.equal(
    viewportBounds(-180, -85.05112899999979, 180, 85.05112899999995),
    "-180,-85.05113,180,85.05113",
  );
  assert.ok(parseBbox(viewportBounds(1e-14, -10, 20.123456789, 10)));
  assert.ok(parseBbox(viewportBounds(160, -30, 200, 10)));
});
test("count and sensor copy is translated with its placeholders intact", () => {
  for (const text of [
    "Showing {shown} of at least {total} in this view. Some publisher records were not acquired in this refresh.",
    "All {total} detections in this view are on the map. Zoomed out, each dot counts the detections around it; zoom in to open single detections.",
    "All {total} detections worldwide are on the map. Zoomed out, each dot counts the detections around it; zoom in to open single detections.",
    "{total} detections in this view",
    "{total} detections worldwide",
  ]) {
    const italian = translate("it", text);
    assert.notEqual(italian, text);
    for (const key of text.match(/\{\w+\}/g)!) assert(italian.includes(key));
  }
});
test(
  "geospatial context follows settled viewports with one bounded read and reports counts per source and sensor",
  { timeout: 60000 },
  async () => {
    const server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        "5196",
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:5196")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.addInitScript({
        content: `window.EventSource=class{constructor(){}addEventListener(){}close(){}};`,
      });
      const reads: (string | null)[] = [];
      const sensor = (
        id: string,
        label: string,
        shown: number,
        total: number,
      ) => ({
        id,
        label,
        status: "ok",
        features_count: shown,
        total_available: total,
        source_url: "https://example.invalid/" + id,
      });
      await page.route("**/*", async (route: any) => {
        const u = new URL(route.request().url());
        if (u.pathname === "/src/client/Map.tsx")
          return route.fulfill({
            contentType: "text/javascript",
            body: `export const colors={informational:'#69c',minor:'#fc6',significant:'#fa6',severe:'#f77',critical:'#f44',unknown:'#aaa'};export default function Map(p){window.__mapBounds=p.onBounds;return null}`,
          });
        if (u.pathname === "/api/brief")
          return route.fulfill({ json: { current: null, pending: false } });
        if (u.pathname === "/api/snapshot")
          return route.fulfill({
            json: {
              incidents: [],
              incoming: [],
              sources: [],
              status: {},
              cursor: "1",
            },
          });
        if (u.pathname === "/api/geospatial") {
          reads.push(u.searchParams.get("bbox"));
          const base = {
            status: "ok",
            checked_at: "2026-10-21T00:00:00Z",
            cadence_seconds: 600,
            source_url: "https://example.invalid",
            attribution: "Fixture attribution",
            license_url: "https://example.invalid/licence",
          };
          return route.fulfill({
            json: {
              bbox: [-180, -90, 180, 90],
              features: [],
              sources: [
                {
                  ...base,
                  id: "copernicus",
                  features_count: 12,
                  total_available: 26,
                  truncated: true,
                },
                {
                  ...base,
                  id: "firms",
                  features_count: 5400,
                  total_available: 5400,
                  truncated: false,
                  error: "source_unavailable",
                  sensors: [
                    sensor("noaa-20-viirs", "NOAA-20 VIIRS", 3000, 3000),
                    sensor("noaa-21-viirs", "NOAA-21 VIIRS", 2400, 2400),
                    {
                      ...sensor("snpp-viirs", "Suomi NPP VIIRS", 0, 0),
                      status: "error",
                      error: "source_http_403",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (u.pathname.startsWith("/api/"))
          throw Error("Unexpected API fixture " + u.pathname);
        if (u.hostname !== "127.0.0.1") return route.abort();
        return route.continue();
      });
      await page.goto("http://127.0.0.1:5196");
      await page.waitForFunction(() => (window as any).__mapBounds);
      await page.evaluate(() => (window as any).__mapBounds("-20,30,40,60"));
      await page.waitForTimeout(600);
      assert.deepEqual(
        reads,
        [],
        "no geospatial read before a layer is enabled",
      );
      await page
        .getByRole("button", { name: "Contextual controls", exact: true })
        .click();
      await page.getByLabel("Satellite thermal detections").check();
      await page.waitForTimeout(600);
      assert.deepEqual(reads, ["-20,30,40,60"]);
      await page.getByLabel("Copernicus mapping areas").check();
      await page.waitForTimeout(600);
      assert.equal(reads.length, 1, "a second layer reuses the same catalog");
      await page.evaluate(() => {
        for (const view of [
          "150,-40,-170,10",
          "160,-30,-160,0",
          "170,-20,-170,0",
        ])
          (window as any).__mapBounds(view);
      });
      await page.waitForTimeout(600);
      assert.deepEqual(
        reads,
        ["-20,30,40,60", "170,-20,-170,0"],
        "rapid moves settle into one read of the final dateline-crossing view",
      );
      await page
        .getByRole("button", {
          name: "Explore geospatial context",
          exact: true,
        })
        .click();
      await page
        .getByText(
          "All 5,400 detections in this view are on the map. Zoomed out, each dot counts the detections around it; zoom in to open single detections.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByText(
          "Showing 12 of at least 26 in this view. Some publisher records were not acquired in this refresh.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByText("NOAA-20 VIIRS · 3,000 detections in this view", {
          exact: true,
        })
        .waitFor();
      await page
        .getByText("Suomi NPP VIIRS · Sensor unavailable · source http 403", {
          exact: true,
        })
        .waitFor();
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
