import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { sourceRegistry } from "../src/collector/registry.js";
import { FIRMS_SENSORS } from "../src/server/geospatial.js";

const ORIGIN = "http://127.0.0.1:5197";
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const listed = { accepted_items: { a: "x", b: "y" } };
const health = (seconds: number, extra: object = {}) => ({
  checked_at: ago(seconds),
  last_success_at: ago(seconds),
  error: null,
  received: 2,
  checkpoint: listed,
  ...extra,
});
const fixtures: Record<string, object> = {
  "global-usgs-earthquakes": health(60, {
    checkpoint: { ...listed, issuer_lag: [[ago(600), 90], [ago(300), 120], [ago(60), 180]] },
  }),
  "global-gdacs-alerts": health(60, { last_success_at: ago(900), error: "source_http_503" }),
  "us-nws-warnings": health(3600),
  "ca-eccc-warnings": health(120, { checkpoint: { accepted_items: {} } }),
  "global-ripestat-routing": health(60, { checkpoint: { routing: { next: 3, ongoing: ["IR-2026"] } } }),
  "uk-tfl-roads": {},
  "meteoalarm-it": {},
};
const sources = sourceRegistry
  .filter((s) => s.id in fixtures)
  .map((s) => ({ ...s, health: fixtures[s.id] }));
const usgsName = sourceRegistry.find((s) => s.id === "global-usgs-earthquakes")!.name;
const meteoName = sourceRegistry.find((s) => s.id === "meteoalarm-it")!.name;
const nwsName = sourceRegistry.find((s) => s.id === "us-nws-warnings")!.name;

test(
  "the coverage view, the country panel and the status pill show each source's and sensor's status in English and Italian",
  { timeout: 60000 },
  async () => {
    const server = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5197", "--strictPort"],
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
      const open = async (language: "en" | "it") => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await page.addInitScript({
          content: `window.EventSource=class{constructor(){}addEventListener(){}close(){}};localStorage.setItem("ew-language",${JSON.stringify(JSON.stringify(language))});`,
        });
        await page.route("**/*", async (route: any) => {
          const u = new URL(route.request().url());
          if (u.origin !== ORIGIN) return route.abort();
          if (u.pathname === "/src/client/Map.tsx")
            return route.fulfill({
              contentType: "text/javascript",
              body: `export const colors={informational:'#69c',minor:'#fc6',significant:'#fa6',severe:'#f77',critical:'#f44',unknown:'#aaa'};export default function Map(p){window.__country=p.onCountry;return null}`,
            });
          if (u.pathname === "/api/brief") return route.fulfill({ json: { current: null, pending: false } });
          if (u.pathname === "/api/snapshot")
            return route.fulfill({ json: { incidents: [], incoming: [], sources, status: {}, cursor: "1" } });
          if (u.pathname === "/api/geospatial") {
            const layer = {
              status: "ok",
              checked_at: ago(60),
              cadence_seconds: 600,
              source_url: "https://example.invalid",
              attribution: "Fixture attribution",
              license_url: "https://example.invalid/licence",
              truncated: false,
            };
            const snpp = FIRMS_SENSORS.find((s) => s.id === "snpp-viirs")!;
            return route.fulfill({
              json: {
                bbox: [-180, -90, 180, 90],
                features: [],
                sources: [
                  { ...layer, id: "copernicus", features_count: 0, total_available: 0 },
                  {
                    ...layer,
                    id: "firms",
                    features_count: 4,
                    total_available: 4,
                    sensors: FIRMS_SENSORS.map((s) => ({
                      id: s.id,
                      label: s.label,
                      status: s.ended ? "ended" : "ok",
                      features_count: s.ended ? 0 : 2,
                      total_available: s.ended ? 0 : 2,
                      source_url: s.url,
                      ...(s.ended ? { ended_at: snpp.ended!.at, notice_url: snpp.ended!.notice_url } : {}),
                    })),
                  },
                ],
              },
            });
          }
          if (u.pathname.startsWith("/api/")) throw Error("Unexpected API fixture " + u.pathname);
          return route.continue();
        });
        await page.goto(ORIGIN);
        return page;
      };
      const page = await open("en");
      // USGS, RIPEstat and ECCC are on schedule; GDACS is failing and NWS stale; TfL and MeteoAlarm are not read.
      const pill = page.locator(".health-pill");
      await pill.getByText("3/5 sources fresh", { exact: true }).waitFor();
      assert.equal(await pill.locator(".coverage-dot").getAttribute("class"), "coverage-dot failing");
      await page.getByRole("button", { name: "Contextual controls", exact: true }).click();
      const view = page.locator(".coverage");
      await view.getByText("No reports", { exact: true }).waitFor();
      await view.getByText("Not covered", { exact: true }).waitFor();
      const row = (name: string) => view.locator("li", { hasText: name });
      assert.equal(await row(usgsName).locator(".coverage-chip").innerText(), "Observed");
      await row(usgsName).getByText("Issuer to ingest: median 2 min · p90 3 min · n 3", { exact: true }).waitFor();
      await row(usgsName).getByText("Ingest to publication: no samples yet", { exact: true }).waitFor();
      assert.equal(await row(nwsName).locator(".coverage-chip").innerText(), "Stale");
      await row(nwsName).getByText("Latency: no samples yet", { exact: true }).waitFor();
      assert.equal(await row("GDACS").locator(".coverage-chip").innerText(), "Failing");
      assert.equal(await row("ECCC").locator(".coverage-chip").innerText(), "Quiet");
      assert.deepEqual(
        await row("RIPEstat").locator(".coverage-chip").allInnerTexts(),
        ["Observed", "Access unresolved"],
      );
      // Failing and stale sources come first.
      assert.match(await view.locator(".coverage-list li").first().innerText(), /^Failing/);
      await view.getByText("Satellite sensors and mapping areas are checked while their layer is on.").waitFor();
      await view.locator("summary", { hasText: "Not read (2)" }).click();
      assert.equal(await row(meteoName).locator(".coverage-chip").innerText(), "Access unresolved");
      assert.equal(await row("TfL").locator(".coverage-chip").innerText(), "Not configured");

      await page.getByLabel("Satellite thermal detections").check();
      const suomi = view.locator("li", { hasText: "Suomi NPP VIIRS 375 m" });
      await suomi.getByText("Ended", { exact: true }).waitFor();
      await suomi.getByText(/^Delivery ended Nov 2, 2026 · Issuer notice/).waitFor();
      assert.match(
        await suomi.getByRole("link", { name: "Issuer notice" }).getAttribute("href"),
        /earthdata\.nasa\.gov/,
      );
      assert.equal(
        await view.locator("li", { hasText: "NOAA-21 VIIRS 375 m" }).locator(".coverage-chip").innerText(),
        "Observed",
      );

      await page.evaluate(() => (window as any).__country("Italy"));
      const panel = page.locator(".panel-content");
      await panel.getByRole("heading", { name: "Italy" }).waitFor();
      const country = panel.locator(".coverage-list li");
      const names = await country.allInnerTexts();
      assert(names.some((n: string) => n.startsWith("Access unresolved") && n.includes(meteoName)));
      assert(names.some((n: string) => n.includes(usgsName) && n.includes("worldwide")));
      assert(!names.some((n: string) => n.includes(nwsName)), "a US source says nothing about Italy");
      await page.close();

      const italian = await open("it");
      await italian.locator(".health-pill").getByText("3/5 fonti aggiornate", { exact: true }).waitFor();
      await italian.getByRole("button", { name: "Controlli contestuali", exact: true }).click();
      const it = italian.locator(".coverage");
      await it.getByRole("heading", { name: "Copertura" }).waitFor();
      await it.getByText("Nessuna segnalazione", { exact: true }).waitFor();
      await it.getByText("Non coperto", { exact: true }).waitFor();
      assert.equal(
        await it.locator("li", { hasText: usgsName }).locator(".coverage-chip").innerText(),
        "Osservata",
      );
      await it
        .locator("li", { hasText: usgsName })
        .getByText("Dall’ente all’acquisizione: mediana 2 min · p90 3 min · n 3", { exact: true })
        .waitFor();
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
