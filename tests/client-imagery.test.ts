import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { addDays, utcDay } from "../src/client/imagery.js";

const ORIGIN = "http://127.0.0.1:5195";
const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, "utf8");
// A 1 x 1 PNG stands in for every GIBS tile.
const TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const incident = {
  id: "manila",
  version: 1,
  headline: "Fixture manila",
  summary_en: "",
  summary_it: null,
  activity: "tropical_cyclone",
  impact: "significant",
  evidence_status: "official_advisory",
  location: { name: "Manila", country: "PH", lon: 120.99, lat: 14.59, accuracy: "area", radius_km: 50 },
  event_start: "2026-10-18T00:00:00Z",
  event_end: null,
  published_at: null,
  ingested_at: "2026-10-18T00:00:00Z",
  analyzed_at: null,
  updated_at: "2026-10-18T00:00:00Z",
  expires_at: null,
  claims: [],
  reports: [],
  history: [],
  review_needed: false,
  cancelled: false,
};

test(
  "NASA imagery requests nothing until chosen, loads the newest finished day and stops when off; an incident lists Copernicus scenes on demand",
  { timeout: 90000 },
  async () => {
    const server = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5195", "--strictPort"],
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
      const today = utcDay(Date.now()),
        yesterday = addDays(today, -1);
      const open = async (language: "en" | "it") => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const tiles: string[] = [],
          domains: string[] = [],
          searches: URL[] = [],
          elsewhere: string[] = [];
        await page.addInitScript({
          content: `localStorage.setItem("ew-language",${JSON.stringify(JSON.stringify(language))});window.EventSource=class{constructor(){}addEventListener(){}close(){}};`,
        });
        await page.route("**/*", async (route: any) => {
          const u = new URL(route.request().url());
          if (u.origin === "https://gibs.earthdata.nasa.gov") {
            if (u.pathname.endsWith(".xml")) {
              domains.push(u.pathname);
              return route.fulfill({
                contentType: "text/xml",
                headers: { "access-control-allow-origin": "*" },
                body: `<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>${addDays(today, -30)}/${today}/P1D</Domain><Size>1</Size></DimensionDomain></Domains>`,
              });
            }
            tiles.push(u.pathname);
            return route.fulfill({
              contentType: "image/png",
              headers: { "access-control-allow-origin": "*" },
              body: TILE,
            });
          }
          if (u.origin === "https://stac.dataspace.copernicus.eu") {
            searches.push(u);
            const name =
              u.searchParams.get("collections") === "sentinel-2-l2a"
                ? "cdse-stac-sentinel-2.json"
                : "cdse-stac-sentinel-1.json";
            return route.fulfill({
              contentType: "application/geo+json",
              headers: { "access-control-allow-origin": "*" },
              body: fixture(name),
            });
          }
          if (u.origin !== ORIGIN) {
            elsewhere.push(u.origin);
            return route.abort();
          }
          if (u.pathname === "/api/snapshot")
            return route.fulfill({
              json: { incidents: [incident], incoming: [], sources: [], status: {}, cursor: "1" },
            });
          if (u.pathname === "/api/brief") return route.fulfill({ json: { current: null, pending: false } });
          if (u.pathname === "/api/incidents/manila") return route.fulfill({ json: incident });
          if (u.pathname.startsWith("/api/")) throw Error("Unexpected API fixture " + u.pathname);
          return route.continue();
        });
        await page.goto(ORIGIN);
        await page.waitForSelector(".map[data-map-ready=true]");
        return { page, tiles, domains, searches, elsewhere };
      };

      const { page, tiles, domains, elsewhere } = await open("en");
      await page.waitForTimeout(1000);
      assert.equal(tiles.length + domains.length, 0, "imagery that is off requests nothing");
      await page.getByRole("button", { name: "Contextual controls", exact: true }).click();
      await page.getByLabel("Satellite imagery").selectOption({ label: "True colour, VIIRS" });
      const day = page.getByLabel("Day (UTC)");
      await page.waitForFunction(
        (want: string) => (document.querySelector("#imagery-day") as HTMLInputElement)?.value === want,
        yesterday,
      );
      assert.deepEqual(domains, [
        `/wmts/epsg3857/best/1.0.0/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/GoogleMapsCompatible_Level9/all/${addDays(today, -30)}.xml`,
      ]);
      assert.equal(await day.getAttribute("max"), today);
      assert.equal(await day.getAttribute("min"), "2018-01-05");
      const tilePath = new RegExp(
        `^/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${yesterday}/GoogleMapsCompatible_Level9/(\\d+)/\\d+/\\d+\\.jpg$`,
      );
      for (let n = 0; n < 50 && !tiles.length; n++) await page.waitForTimeout(100);
      assert.ok(tiles.length > 0, "the chosen day's tiles load");
      for (const t of tiles) {
        const m = tilePath.exec(t);
        assert.ok(m, t);
        assert.ok(+m[1] <= 9, "no request past the matrix set's last level");
      }
      const control = page.locator(".imagery-control");
      await control.getByText(`Daily mosaic of passes on ${yesterday}`).waitFor();
      await control.getByText("NOAA-20 VIIRS, bands I1, M4, M3 · Daytime passes, about 13:30 local solar time").waitFor();
      await control.getByText("Not measured for a daily mosaic. Clouds appear as imaged.").waitFor();
      await control.getByText(/^Imagery from NASA's Global Imagery Browse Services/).waitFor();
      assert.match(
        await page.locator(".maplibregl-ctrl-attrib-inner").innerHTML(),
        new RegExp(`NASA GIBS</a>, NOAA-20 VIIRS, bands I1, M4, M3, ${yesterday}`),
      );
      assert.equal(await page.locator(".map").getAttribute("data-map-error"), null);

      // A new day and a new layer replace the source; a day NASA does not list is said so.
      await day.fill("2026-09-01");
      await control.getByText("NASA lists no imagery for this day.").waitFor();
      await page.getByLabel("Satellite imagery").selectOption({ label: "Night lights, VIIRS" });
      for (let n = 0; n < 50 && !tiles.some((t) => t.includes("DayNightBand")); n++)
        await page.waitForTimeout(100);
      assert.ok(
        tiles.some((t) =>
          /DayNightBand_At_Sensor_Radiance\/default\/2026-09-01\/GoogleMapsCompatible_Level8\/\d+\/\d+\/\d+\.png$/.test(t),
        ),
      );

      await page.getByLabel("Satellite imagery").selectOption({ label: "Off" });
      await page.waitForTimeout(300);
      const settled = tiles.length;
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.waitForTimeout(1500);
      assert.equal(tiles.length, settled, "imagery that is off requests nothing on zoom");
      assert.equal(await page.locator(".maplibregl-ctrl-attrib-inner").innerHTML().then((h: string) => h.includes("NASA GIBS")), false);
      assert.ok(!elsewhere.some((o: string) => /nasa|copernicus|creodias/.test(o)), elsewhere.join());
      await page.close();

      const scenes = await open("en");
      await scenes.page
        .getByRole("button", { name: "Fixture manila, tropical cyclone, significant, official advisory", exact: true })
        .click();
      const section = scenes.page.locator(".recent-imagery");
      await section.getByRole("heading", { name: "Satellite imagery" }).waitFor();
      assert.equal(scenes.searches.length, 0, "the catalogue is asked only on request");
      await section.getByText("The mapped point is approximate, so a scene may miss part of the affected area.").waitFor();
      await section.getByRole("button", { name: "Find recent Sentinel scenes" }).click();
      const rows = section.locator(".scene-list li");
      await rows.nth(6).waitFor();
      assert.equal(await rows.count(), 7);
      assert.deepEqual(
        scenes.searches.map((u: URL) => [u.searchParams.get("collections"), u.searchParams.get("bbox")]).sort(),
        [
          ["sentinel-1-grd", "120.985,14.585,120.995,14.595"],
          ["sentinel-2-l2a", "120.985,14.585,120.995,14.595"],
        ],
      );
      assert.ok(scenes.searches.every((u: URL) => u.searchParams.get("datetime")!.startsWith("2026-10-08T00:00:00.000Z/")));
      // Newest first across both collections, each with its acquisition, relation to the event and conditions.
      const first = await rows.nth(0).innerText();
      assert.match(first, /Sentinel-2C · Sentinel-2 L2A optical/);
      assert.match(first, /23 Oct 2026, 02:17 UTC · 5 days after the event/);
      assert.match(first, /Cloud over 100% of its 110 km tile, not measured at this point/);
      const radar = rows.filter({ hasText: "Sentinel-1C" });
      assert.match(await radar.innerText(), /IW VV\+VH · ascending · radar sees through cloud/);
      assert.match(await radar.innerText(), /5 days before the event/);
      assert.match(
        await radar.getByRole("link", { name: "Open this day in the Copernicus Browser" }).getAttribute("href"),
        /^https:\/\/browser\.dataspace\.copernicus\.eu\/\?.*datasetId=S1_CDAS_IW_VVVH.*fromTime=2026-10-13T00%3A00%3A00\.000Z/,
      );
      await section.getByText(/Copernicus Sentinel data 2026\. Previews stay in the Copernicus Browser\./).waitFor();
      assert.equal(await section.locator("img").count(), 0, "no catalogue thumbnail is embedded");

      await section.getByRole("button", { name: "Show the event day on the map" }).click();
      for (let n = 0; n < 50 && !scenes.tiles.length; n++) await scenes.page.waitForTimeout(100);
      assert.ok(scenes.tiles.length > 0);
      assert.ok(scenes.tiles.every((t: string) => t.includes("/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-10-18/")));
      await scenes.page.close();

      const italian = await open("it");
      await italian.page
        .locator(".feed-item", { hasText: "Fixture manila" })
        .click();
      const it = italian.page.locator(".recent-imagery");
      await it.getByRole("heading", { name: "Immagini satellitari" }).waitFor();
      await it.getByRole("button", { name: "Trova scene Sentinel recenti" }).click();
      await it.locator(".scene-list li").nth(6).waitFor();
      assert.match(
        await it.locator(".scene-list li").nth(0).innerText(),
        /Nuvole sul 100% del suo riquadro di 110 km, non misurate in questo punto/,
      );
      await it.getByText(/5 giorni dopo l’evento/).first().waitFor();
      await italian.page.getByRole("button", { name: "Controlli contestuali", exact: true }).click();
      await italian.page.getByLabel("Immagini satellitari").selectOption({ label: "Colori reali, MODIS" });
      await italian.page.locator(".imagery-control").getByText(`Mosaico giornaliero dei passaggi del ${yesterday}`).waitFor();
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
