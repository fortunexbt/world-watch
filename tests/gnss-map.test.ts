import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import {
  GnssAccumulator,
  gnssGrid,
  gnssManifest,
  type GnssCell,
} from "../src/shared/gnss.js";

const ORIGIN = "http://127.0.0.1:5203";
// Counts GeoJSON loads ("LD", one per setData) by source through the map worker's messages.
const instrument = `
  window.__loads = {};
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (data, ...rest) {
    if (data && data.type === "LD") { const id = data.data && data.data.source; window.__loads[id] = (window.__loads[id] || 0) + 1; }
    return post.call(this, data, ...rest);
  };
  window.EventSource = class { constructor() {} addEventListener() {} close() {} };
`;
// A real-sized band of 14,400 cells across the map's opening view, interference over its western half.
const cells: GnssCell[] = [];
for (let south = 0; south < 30; south += 0.5)
  for (let west = -60; west < 60; west += 0.5)
    cells.push([south, west, 40, west < 0 ? 12 : 0]);
const { grid, counts } = gnssGrid(new GnssAccumulator(), "2026-10-22");
grid.cells = cells;
const manifest = gnssManifest(
  "2026-10-22",
  "v2026.10.22-planes-readsb-prod-0",
  {
    ...counts,
    reference_aircraft: 61204,
    classified_reports: 23087261,
    cells_published: cells.length,
  },
  { file: "gnss-2026-10-22.json", bytes: 1, sha256: "0".repeat(64) },
  new Date().toISOString(),
);

test(
  "the GNSS grid loads only when its private layer is on, draws once, credits the ODbL and explains a clicked cell",
  { timeout: 90000 },
  async () => {
    const server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        "5203",
        "--strictPort",
      ],
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
      const open = async (served: (path: string) => any) => {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
        });
        const errors: string[] = [],
          reads: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(String(e)));
        await page.addInitScript({ content: instrument });
        await page.route("**/*", async (route: any) => {
          const u = new URL(route.request().url());
          if (u.origin !== ORIGIN) return route.abort();
          if (u.pathname.startsWith("/gnss/")) {
            reads.push(u.pathname);
            return route.fulfill(served(u.pathname));
          }
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
          if (u.pathname.startsWith("/api/"))
            return route.fulfill({ json: { current: null, pending: false } });
          return route.continue();
        });
        await page.goto(ORIGIN);
        await page.waitForSelector('.map[data-boundaries="loaded"]');
        await page.waitForTimeout(800);
        const toggle = async () => {
          await page
            .getByRole("button", { name: "Contextual controls", exact: true })
            .click();
          await page
            .getByLabel("GNSS interference from aircraft reports", {
              exact: true,
            })
            .check();
          await page.waitForTimeout(1500);
        };
        return { page, errors, reads, toggle };
      };
      const files = (path: string) => ({
        json: path === "/gnss/manifest.json" ? manifest : grid,
      });
      const { page, errors, reads, toggle } = await open(files);
      const attribution = () =>
        page.locator(".maplibregl-ctrl-attrib-inner").innerText();
      const legend = page.getByRole("group", { name: "Map legend" });
      assert.deepEqual(reads, [], "nothing is read before the layer is on");
      assert.doesNotMatch(await attribution(), /globe_history/);
      await toggle();
      assert.deepEqual(reads, [
        "/gnss/manifest.json",
        "/gnss/gnss-2026-10-22.json",
      ]);
      assert.equal(
        await page.evaluate(() => (window as any).__loads["gnss-grid"]),
        2,
        "once empty when added, then once with the grid",
      );
      assert.match(
        await attribution(),
        /Contains information from ADSB\.lol globe_history, made available under the ODbL/,
      );
      for (const label of ["GNSS degraded", "under 2%", "2 to 10%", "over 10%"])
        assert.ok(
          await legend.getByText(label, { exact: true }).isVisible(),
          label,
        );
      const coverage = page.locator(".coverage-list li", {
        hasText: "GNSS interference grid",
      });
      assert.match(await coverage.innerText(), /14400 cells worldwide/);
      assert.match(await coverage.innerText(), /Observed/);

      // Panning does not resend the grid.
      await page.mouse.move(1000, 600);
      await page.mouse.down();
      for (let s = 1; s <= 8; s++) await page.mouse.move(1000 - s * 15, 600);
      await page.mouse.up();
      await page.waitForTimeout(600);
      assert.equal(
        await page.evaluate(() => (window as any).__loads["gnss-grid"]),
        2,
      );

      // A click inside the band opens that cell with its counts and the ODbL notice.
      const box = (await page.locator(".map").boundingBox())!;
      await page.keyboard.press("Escape");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const panel = page.locator(".geospatial-panel");
      await panel
        .getByRole("heading", {
          name: "GNSS interference from aircraft reports",
        })
        .waitFor();
      const text = await panel.innerText();
      assert.match(text, /does not prove interference/i);
      assert.match(
        text,
        /Aircraft\s+40\s+Reported degraded GNSS\s+12 · 27\.5% after discounting one aircraft · over 10%/,
      );
      assert.match(
        text,
        /from 61,204 aircraft and 23,087,261 classified reports/,
      );
      assert.match(text, /latitude/);
      assert.match(
        text,
        /Contains information from ADSB\.lol globe_history, which is made available here under the Open Database License \(ODbL\)\./,
      );
      assert.equal(
        await panel
          .getByRole("link", { name: "Download this grid (ODbL)" })
          .getAttribute("href"),
        "/gnss/gnss-2026-10-22.json",
      );
      await page
        .getByRole("button", { name: "Contextual controls", exact: true })
        .click();
      await page
        .getByLabel("Interface language", { exact: true })
        .selectOption("it");
      await page
        .getByRole("button", { name: "Esplora le interferenze GNSS" })
        .click();
      await page
        .getByRole("heading", {
          name: "Interferenze GNSS dai dati degli aerei",
        })
        .waitFor();
      assert.ok(
        await page.locator(".legend").getByText("oltre il 10%").isVisible(),
      );
      assert.deepEqual(errors, []);

      // A build without a grid falls through to the app shell; a grid under another licence is refused.
      for (const [served, message] of [
        [
          () => ({ contentType: "text/html", body: "<!doctype html>" }),
          "No GNSS interference grid has been built for this app.",
        ],
        [
          (path: string) => ({
            json:
              path === "/gnss/manifest.json"
                ? { ...manifest, license: "CC-BY-NC-4.0" }
                : grid,
          }),
          "The GNSS interference grid failed validation.",
        ],
      ] as const) {
        const other = await open(served);
        await other.toggle();
        await other.page
          .getByRole("button", { name: "Explore GNSS interference" })
          .click();
        await other.page.getByText(message, { exact: true }).waitFor();
        assert.equal(
          await other.page.evaluate(() => (window as any).__loads["gnss-grid"]),
          1,
          "nothing drawn",
        );
      }
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
