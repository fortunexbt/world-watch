import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  glyphs,
  GLYPH_ACTIVITIES,
  HAZARDS,
  hasGlyph,
  isHazard,
  magnitude,
  markerIcon,
  markerScale,
} from "../src/client/hazards.js";
import { translate } from "../src/client/locale.js";
import { parseUsgs } from "../src/collector/adapters/usgs.js";
import { parseGdacs } from "../src/collector/adapters/gdacs.js";
import { parseNws } from "../src/collector/adapters/nws.js";
import { parseEccc } from "../src/collector/adapters/eccc.js";
import { parseAdsbLol } from "../src/collector/adapters/adsblol.js";
import { parseRipestatRouting } from "../src/collector/adapters/ripestat.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { Impact } from "../src/shared/contracts.js";

const source = (id: string) => sourceRegistry.find((s) => s.id === id)!;
const usgs = parseUsgs(
  source("global-usgs-earthquakes"),
  JSON.parse(readFileSync("tests/fixtures/usgs-summary.json", "utf8")),
);
const gdacs = parseGdacs(
  source("global-gdacs-alerts"),
  JSON.parse(readFileSync("tests/fixtures/gdacs-events.json", "utf8")),
);
const warnings = [
  ...parseNws(
    source("us-nws-warnings"),
    JSON.parse(readFileSync("tests/fixtures/nws-alerts.json", "utf8")),
  ),
  ...parseEccc(
    source("ca-eccc-warnings"),
    JSON.parse(readFileSync("tests/fixtures/eccc-alerts.json", "utf8")),
  ),
];
const squawks = JSON.parse(
  readFileSync("tests/fixtures/adsblol-aircraft.json", "utf8"),
);
for (const a of squawks.ac) a.squawk = "7700";
const aircraft = parseAdsbLol(
  source("global-adsblol-emergency-squawks"),
  squawks,
);

test("earthquake markers grow with magnitude between a floor and a ceiling", () => {
  assert.equal(markerScale(null), 1);
  assert.equal(markerScale(4.5), 0.8);
  assert.equal(markerScale(3.1), 0.8);
  assert.equal(markerScale(8), 1.6);
  assert.equal(markerScale(9.5), 1.6);
  assert.ok(markerScale(5) < markerScale(6) && markerScale(6) < markerScale(7));
  assert.ok(Math.abs(markerScale(6.25) - 1.2) < 1e-9);
});

test("magnitude comes from the USGS record and nothing else", () => {
  for (const row of usgs)
    assert.equal(
      magnitude({ reports: [{ excerpts: row.excerpts }] }),
      JSON.parse(row.excerpts[0].text).magnitude,
    );
  assert.equal(magnitude({ reports: [{ excerpts: usgs[0].excerpts }] }), 4.9);
  for (const row of gdacs)
    assert.equal(magnitude({ reports: [{ excerpts: row.excerpts }] }), null);
  const record = (text: string) => ({
    reports: [{ excerpts: [{ id: "usgs-event", text }] }],
  });
  assert.equal(magnitude(record('{"magnitude":null}')), null);
  assert.equal(magnitude(record('{"magnitude":"7.1"}')), null);
  assert.equal(magnitude(record("M 7.1 earthquake")), null);
  assert.equal(magnitude({ reports: [] }), null);
  assert.equal(magnitude({ reports: [{}] }), null);
});

const drops = parseRipestatRouting(
  source("global-ripestat-routing"),
  "SY",
  JSON.parse(readFileSync("tests/fixtures/ripestat-routing.json", "utf8"))[
    "sy-2012"
  ],
  Date.parse("2012-12-01T17:00:00Z"),
)!;

test("every activity the structured adapters publish has a glyph, a map image per impact and both interface languages", () => {
  assert.deepEqual(Object.keys(glyphs), [...GLYPH_ACTIVITIES]);
  assert.deepEqual(GLYPH_ACTIVITIES.slice(0, HAZARDS.length), [...HAZARDS]);
  for (const row of [...usgs, ...gdacs, ...warnings, ...aircraft])
    assert.ok(isHazard(row.official?.activity ?? ""), row.native_id);
  // A routing drop has a glyph but is not a natural hazard; it sits with disruptions.
  assert.equal(drops.length, 1);
  for (const row of drops) {
    assert.ok(hasGlyph(row.official?.activity ?? ""), row.native_id);
    assert.equal(isHazard(row.official?.activity ?? ""), false);
  }
  for (const activity of GLYPH_ACTIVITIES) {
    assert.match(glyphs[activity], /^M[\d\s.,a-zA-Z-]+$/);
    assert.notEqual(translate("it", activity), activity.replaceAll("_", " "));
    for (const impact of Impact.options)
      assert.equal(
        markerIcon({ activity, impact }),
        `hazard-${activity}-${impact}`,
      );
  }
  assert.equal(
    markerIcon({ activity: "planned_demonstration", impact: "minor" }),
    "impact-minor",
  );
  assert.equal(isHazard("official_advisory"), false);
  for (const text of ["Map legend", "Legend", "approximate area"])
    assert.notEqual(translate("it", text), text);
});

test(
  "hazard markers scale on the live map and feed rows and legend name their glyphs",
  { timeout: 60000 },
  async () => {
    const server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        "5193",
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:5193")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({ headless: true });
      const record = (id: string, activity: string, lat: number) => ({
        id,
        version: 1,
        headline: "Fixture " + id,
        summary_en: "",
        summary_it: null,
        activity,
        impact: "severe",
        evidence_status: "official_advisory",
        location: {
          name: "Fixture place",
          country: null,
          lon: 20,
          lat,
          accuracy: "point",
          radius_km: 8,
        },
        event_start: "2026-10-21T00:00:00Z",
        event_end: null,
        published_at: null,
        ingested_at: "2026-10-21T00:00:00Z",
        analyzed_at: null,
        updated_at: "2026-10-21T00:00:00Z",
        expires_at: null,
        claims: [],
        reports: [] as any[],
        history: [],
        review_needed: false,
        cancelled: false,
      });
      const quake = (id: string, mag: number, lat: number) => ({
        ...record(id, "earthquake", lat),
        reports: [
          {
            report_id: "report-" + id,
            source_id: "global-usgs-earthquakes",
            title: "Fixture",
            rights: { ai: false },
            excerpts: [
              { id: "usgs-event", text: JSON.stringify({ magnitude: mag }) },
            ],
          },
        ],
      });
      const cyclone = record("cyclone", "tropical_cyclone", -45);
      // A USGS quake and the GDACS alert republishing it, linked on both incidents.
      const link = (id: string) => ({
        incident_id: id,
        type: "same_event",
        independence: "same_origin",
        basis: "fusion-1",
        reason: "origin times 0 s apart; both measurements come from NEIC",
      });
      const usgsQuake = {
        ...quake("nagqu", 7, 32),
        impact: "unknown",
        location: { ...record("x", "earthquake", 32).location, lon: 93.7 },
        links: [link("china")],
      };
      const gdacsAlert = {
        ...record("china", "earthquake", 32),
        impact: "significant",
        location: { ...usgsQuake.location, accuracy: "area" },
        reports: [
          {
            report_id: "report-china",
            source_id: "global-gdacs-alerts",
            source_name: "GDACS",
            title: "GDACS alert",
            rights: { ai: false },
            excerpts: [{ id: "gdacs-event", text: JSON.stringify({ alert_level: "Orange" }) }],
          },
        ],
        links: [link("nagqu")],
      };
      const outage = record("outage", "connectivity_disruption", 10);
      const incidents = [
        quake("small", 4.5, 45),
        quake("large", 8, -25),
        {
          ...cyclone,
          impact: "significant",
          location: { ...cyclone.location, lon: 100, accuracy: "area" },
        },
        gdacsAlert,
        usgsQuake,
        {
          ...outage,
          impact: "minor",
          location: { ...outage.location, lon: -60, accuracy: "area" },
        },
      ];
      const open = async (
        viewport: { width: number; height: number },
        language: string,
      ) => {
        const page = await browser.newPage({ viewport });
        const errors: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(String(e)));
        await page.addInitScript({
          content: `localStorage.setItem("ew-language", ${JSON.stringify(JSON.stringify(language))});window.EventSource=class{constructor(){}addEventListener(){}close(){}};`,
        });
        await page.route("**/*", async (route: any) => {
          const u = new URL(route.request().url());
          if (u.origin !== "http://127.0.0.1:5193") return route.abort();
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
          if (u.pathname === "/api/brief")
            return route.fulfill({ json: { current: null, pending: false } });
          const detail = incidents.find((i) => u.pathname === "/api/incidents/" + i.id);
          if (detail) return route.fulfill({ json: detail });
          if (u.pathname.startsWith("/api/"))
            return route.fulfill({ json: {} });
          return route.continue();
        });
        await page.goto("http://127.0.0.1:5193");
        return { page, errors };
      };
      const { page, errors } = await open({ width: 1440, height: 900 }, "en");
      const row = page.getByRole("button", {
        name: "Fixture cyclone, tropical cyclone, significant, official advisory",
        exact: true,
      });
      await row.waitFor();
      assert.equal(await row.locator(".incident-symbol svg").count(), 1);
      const legend = page.getByRole("group", { name: "Map legend" });
      for (const label of [
        "volcanic eruption",
        "drought",
        "connectivity disruption",
        "approximate area",
      ])
        assert.ok(await legend.getByText(label, { exact: true }).isVisible());
      // A connectivity drop carries its glyph and sits under Disruption, not Hazards.
      const outageRow = page.getByRole("button", {
        name: "Fixture outage, connectivity disruption, minor, official advisory",
        exact: true,
      });
      assert.equal(await outageRow.locator(".incident-symbol svg").count(), 1);
      await page.getByRole("button", { name: "Hazards", exact: true }).click();
      assert.equal(await outageRow.count(), 0);
      await page
        .getByRole("button", { name: "Disruption", exact: true })
        .click();
      assert.equal(await page.locator(".feed-item").count(), 1);
      assert.equal(await outageRow.count(), 1);
      await page
        .getByRole("button", { name: "All activity", exact: true })
        .click();

      // Severe-coloured pixels north and south of the equator, with the interface
      // hidden so only the two quakes (and their world copies) are counted.
      await page.waitForSelector(".map[data-map-ready=true]");
      await page.waitForTimeout(800);
      assert.equal(
        await page.locator(".map").getAttribute("data-map-error"),
        null,
      );
      await page.addStyleTag({
        content:
          ".topbar,.rolling-brief,.panel,.legend,.health-pill,.maplibregl-control-container{visibility:hidden!important}",
      });
      const shot = (await page.screenshot()).toString("base64");
      const [small, large] = await page.evaluate(async (data: string) => {
        const img = new Image();
        img.src = "data:image/png;base64," + data;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, img.width, img.height).data;
        const counts = [0, 0];
        for (let i = 0; i < px.length; i += 4)
          if (
            Math.abs(px[i] - 0xed) < 14 &&
            Math.abs(px[i + 1] - 0x75) < 14 &&
            Math.abs(px[i + 2] - 0x75) < 14
          )
            counts[i / 4 / img.width < 490 ? 0 : 1]++;
        return counts;
      }, shot);
      assert.ok(small > 100, `M4.5 marker renders (${small} px)`);
      assert.ok(
        large > 2.5 * small,
        `M8 marker covers more area than M4.5 (${large} vs ${small} px)`,
      );

      const phone = await open({ width: 390, height: 844 }, "it");
      await phone.page
        .getByRole("button", {
          name: "Fixture cyclone, ciclone tropicale, significativo, avviso ufficiale",
          exact: true,
        })
        .waitFor();
      const toggle = phone.page.getByRole("button", {
        name: "Legenda",
        exact: true,
      });
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      const drought = phone.page.getByText("siccità", { exact: true });
      assert.equal(await drought.isVisible(), false);
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.equal(await drought.isVisible(), true);
      // A fresh page, since the pixel count above hid the interface.
      const linked = await open({ width: 1440, height: 900 }, "en");
      const fused = linked.page.locator('[data-incident-id="nagqu"]');
      assert.equal(
        await fused.getAttribute("aria-label"),
        "Fixture nagqu, earthquake, significant, official advisory, 2 sources · one origin",
        "one feed row for the pair, led by the USGS point",
      );
      assert.equal(
        await linked.page.locator('[data-incident-id="china"]').count(),
        0,
      );
      await fused.click();
      const detail = linked.page.locator(".detail");
      await detail
        .getByRole("heading", { name: "One event from linked records" })
        .waitFor();
      assert.ok(
        await detail
          .getByText(
            "These records republish one upstream measurement. They are one origin, not independent corroboration.",
          )
          .isVisible(),
      );
      assert.equal(
        await detail.locator("article.evidence").count(),
        2,
        "both records in the detail panel",
      );
      assert.ok(await detail.getByText("Separate these records").isVisible());

      assert.deepEqual([...errors, ...phone.errors, ...linked.errors], []);
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);
