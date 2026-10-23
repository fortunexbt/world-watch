import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { encodeThermalTile, indexDetections } from "../src/server/thermal-tiles.js";

const at = Date.parse("2026-10-23T09:42:00Z");
const index = indexDetections([
  {
    sensor: "noaa-20-viirs",
    data: {
      lon: Float64Array.of(30, -60, 179.9),
      lat: Float64Array.of(0, -10, -17.8),
      at: Float64Array.of(at, at, at),
      confidence: Uint8Array.of(2, 1, 0),
    },
  },
]);

test(
  "thermal tiles load only while the layer is on, a count opens onto its detections and a detection opens its provenance",
  { timeout: 90000 },
  async () => {
    const server = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5200", "--strictPort"],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:5200")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript({ content: "window.EventSource=class{constructor(){}addEventListener(){}close(){}};" });
      const tiles: string[] = [];
      await page.route("**/*", async (route: any) => {
        const u = new URL(route.request().url());
        if (u.pathname === "/api/snapshot")
          return route.fulfill({ json: { incidents: [], incoming: [], sources: [], status: {}, cursor: "1" } });
        if (u.pathname === "/api/brief") return route.fulfill({ json: { current: null, pending: false } });
        if (u.pathname === "/api/geospatial")
          return route.fulfill({
            json: {
              bbox: [-180, -90, 180, 90],
              features: [],
              thermal_version: "v1",
              sources: [
                {
                  id: "firms",
                  status: "ok",
                  checked_at: "2026-10-23T10:00:00Z",
                  cadence_seconds: 600,
                  features_count: 3,
                  total_available: 3,
                  truncated: false,
                  source_url: "https://example.invalid",
                  attribution: "Fixture attribution",
                  license_url: "https://example.invalid/licence",
                },
              ],
            },
          });
        const tile = u.pathname.match(/^\/api\/thermal\/v1\/(\d+)\/(\d+)\/(\d+)$/);
        if (tile) {
          tiles.push(tile.slice(1).join("/"));
          const data = encodeThermalTile(index, +tile[1], +tile[2], +tile[3]);
          return data
            ? route.fulfill({ body: Buffer.from(data), contentType: "application/x-protobuf" })
            : route.fulfill({ status: 204 });
        }
        if (u.pathname.startsWith("/api/")) throw Error("Unexpected API fixture " + u.pathname);
        if (u.hostname !== "127.0.0.1") return route.abort();
        return route.continue();
      });
      await page.goto("http://127.0.0.1:5200");
      const map = page.locator(".map");
      await page.waitForFunction(() => document.querySelector(".map")?.getAttribute("data-map-bounds"));
      // Screen position of a place in the current Web Mercator view.
      const screen = async (lon: number, lat: number) => {
        const [w, s, e, n] = (await map.getAttribute("data-map-bounds"))!.split(",").map(Number);
        const box = (await map.boundingBox())!,
          y = (v: number) => Math.log(Math.tan(Math.PI / 4 + (v * Math.PI) / 360));
        return [box.x + ((lon - w) / (e - w)) * box.width, box.y + ((y(n) - y(lat)) / (y(n) - y(s))) * box.height];
      };
      await page.waitForTimeout(500);
      assert.equal(tiles.length, 0, "no tile before the layer is on");
      await page.getByRole("button", { name: "Contextual controls", exact: true }).click();
      await page.getByLabel("Satellite thermal detections").check();
      await page.waitForFunction(() => document.querySelector(".map canvas"));
      for (let n = 0; n < 100 && !tiles.length; n++) await page.waitForTimeout(100);
      await page.waitForTimeout(1000);
      assert(tiles.length > 0 && tiles.every((t) => +t.split("/")[0] <= 2), tiles.join());
      // The world copies on screen share one request per tile.
      assert.equal(new Set(tiles).size, tiles.length, tiles.join());
      await page.keyboard.press("Escape");
      // Bounds are exact once less than a whole world is in view.
      await page.mouse.move(990, 470);
      for (let n = 0; n < 3; n++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(150);
      }
      await page.waitForFunction(() => {
        const [w, , e] = document.querySelector(".map")!.getAttribute("data-map-bounds")!.split(",").map(Number);
        return e - w < 300;
      });
      await page.waitForTimeout(800);
      // A world-scale dot is a count: clicking it zooms to where single detections show.
      await page.mouse.click(...(await screen(30, 0)));
      await page.waitForFunction(() => Number(document.querySelector(".map")?.getAttribute("data-map-zoom")) >= 6, null, { timeout: 15000 });
      for (let n = 0; n < 50 && !tiles.some((t) => t.startsWith("6/")); n++) await page.waitForTimeout(100);
      assert(tiles.some((t) => t.startsWith("6/")), tiles.join());
      await page.waitForTimeout(800);
      await page.mouse.click(...(await screen(30, 0)));
      await page.getByRole("heading", { name: "VIIRS thermal anomaly" }).waitFor();
      const panel = await page.locator(".geospatial-panel").innerText();
      for (const text of ["NOAA-20 VIIRS 375 m", "high", "23/10/2026, 09:42:00 UTC", "not a confirmed wildfire", "Open publisher source"])
        assert(panel.includes(text), text);
      // Off, the layer's tiles stop loading however the map moves.
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Contextual controls", exact: true }).click();
      await page.getByLabel("Satellite thermal detections").uncheck();
      await page.keyboard.press("Escape");
      const seen = tiles.length;
      await page.mouse.move(900, 500);
      await page.mouse.down();
      await page.mouse.move(500, 300, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(1000);
      assert.equal(tiles.length, seen);
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
