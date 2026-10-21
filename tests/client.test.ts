import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWhen,
  formatAge,
  eventTime,
  validBounds,
  readLocal,
} from "../src/client/time.js";
import { translate } from "../src/client/locale.js";
test("date-only events keep unknown hour in both interface languages", () => {
  assert.match(formatWhen("2026-10-25", "en"), /time unknown$/);
  assert.match(formatWhen("2026-10-25", "it"), /ora sconosciuta$/);
  assert.equal(formatWhen("2026-02-30"), "Time unknown");
  assert.equal(formatWhen("not-a-date", "it"), "Ora sconosciuta");
  assert.equal(formatAge("not-a-date"), "unknown");
});
test("correction time accepts real dates and explicit offsets, never guessed local hours", () => {
  assert.equal(eventTime("2026-10-25"), true);
  assert.equal(eventTime("2026-10-25T01:00:00Z"), true);
  assert.equal(eventTime("2026-10-25T02:00:00+02:00"), true);
  assert.equal(eventTime("2026-10-25T02:00"), false);
  assert.equal(eventTime("2026-04-31"), false);
  assert.equal(eventTime("2026-10-25T25:00Z"), false);
});
test("private area bounds reject reversed, empty and nonfinite geography", () => {
  assert.equal(validBounds("-1,50,1,52"), true);
  assert.equal(validBounds("1,50,-1,52"), false);
  assert.equal(validBounds("-181,50,1,52"), false);
  assert.equal(validBounds("NaN,50,1,52"), false);
  assert.equal(validBounds(""), false);
});
test("malformed local preferences cannot crash restoration; source evidence stays untouched", () => {
  const old = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "{broken" },
  });
  assert.deepEqual(readLocal("areas", []), []);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => '{"wrong":"shape"}' },
  });
  assert.deepEqual(readLocal("areas", []), []);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: old,
  });
  assert.equal(translate("it", "Source records"), "Documenti delle fonti");
  assert.equal(
    translate("it", "A verbatim source quotation"),
    "A verbatim source quotation",
  );
});

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
test(
  "contextual owner forms, saved filters, private feed scope, retry and Italian interface use isolated API fixtures",
  { timeout: 60000 },
  async () => {
    const server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        "5199",
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      let started = false;
      for (let n = 0; n < 100; n++) {
        try {
          const r = await fetch("http://127.0.0.1:5199");
          if (r.ok) {
            started = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(started, "isolated Vite test server starts");
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const writes: { path: string; body: any }[] = [];
      let snapshotQuery = "";
      const claim = (id: string) => ({
        id,
        summary: "Fixture claim " + id,
        activity: "planned_demonstration",
        evidence_ids: ["e1"],
        places: [],
        event_start: "2026-10-25",
        event_end: null,
        timezone: null,
        temporal_status: "planned",
        time_uncertainty: null,
        impacts: [],
        violence_mentioned: "no",
        impact: "informational",
        impact_uncertainty: null,
        official_instruction: null,
        relationships: [],
      });
      const incident = (id: string) => ({
        id,
        version: 3,
        headline: "Isolated fixture " + id,
        summary_en: "A fixture public gathering.",
        summary_it: "Un raduno di prova.",
        activity: "planned_demonstration",
        impact: "informational",
        evidence_status: "unverified",
        location: {
          name: id === "a" ? "Rome" : "Paris",
          country: id === "a" ? "IT" : "FR",
          lon: 12,
          lat: 42,
          accuracy: "city",
          radius_km: 10,
        },
        event_start: "2026-10-25",
        event_end: null,
        published_at: "2026-10-21T00:00:00Z",
        ingested_at: "2026-10-21T00:00:00Z",
        analyzed_at: "2026-10-21T00:00:00Z",
        updated_at: "2026-10-21T00:00:00Z",
        expires_at: null,
        claims: [claim("c1"), claim("c2")],
        reports: [
          {
            report_id: "report-" + id,
            source_id: "fixture-source",
            title: "Original quotation",
            canonical_url: "https://example.invalid/fixture",
            input_coverage: "permitted_excerpt",
            published_at: null,
            rights: {
              attribution: "Required fixture attribution",
              basis: "Fixture permitted reuse licence",
              redistribute: true,
            },
            excerpts: [{ id: "e1", text: "Verbatim source evidence." }],
          },
        ],
        history: [],
        review_needed: false,
        cancelled: false,
      });
      const incidents = [incident("a"), incident("b")];
      const source = {
        id: "fixture-source",
        name: "Fixture source",
        status: "enabled",
        languages: ["en"],
        countries: ["IT"],
        url: "https://example.invalid",
        rights: { display: true, attribution: "Isolated fixture" },
        health: { last_success_at: "2026-10-21T00:00:00Z" },
      };
      const incoming = [
        {
          report_id: "r1",
          job_id: "j1",
          title: "Isolated failed report",
          source_id: source.id,
          canonical_url: "https://example.invalid/report",
          state: "permanently_failed",
          processing_status: "Analysis needs review",
          error_kind: "invalid",
          ingested_at: "2026-10-21T00:00:00Z",
        },
      ];
      // Register before specific API routes: all non-loopback requests are blocked.
      await page.route("**/*", async (route: any) => {
        if (new URL(route.request().url()).origin !== "http://127.0.0.1:5199")
          return route.abort();
        return route.continue();
      });
      await page.route("**/api/**", async (route: any) => {
        const request = route.request(),
          url = new URL(request.url());
        if (request.method() === "POST") {
          writes.push({ path: url.pathname, body: request.postDataJSON() });
          await route.fulfill({ json: { accepted: true } });
          return;
        }
        if (url.pathname === "/api/events") {
          await route.fulfill({
            contentType: "text/event-stream",
            body: ": heartbeat\n\n",
          });
          return;
        }
        if (url.pathname === "/api/snapshot") {
          snapshotQuery = url.search;
          await route.fulfill({
            json: {
              incidents,
              incoming,
              sources: [source],
              status: {
                worker_state: "paused",
                worker_last_seen: null,
                pending: 1,
              },
              cursor: "10",
              limited: true,
            },
          });
          return;
        }
        const id = url.pathname.split("/").pop();
        await route.fulfill({ json: incidents.find((i) => i.id === id) ?? {} });
      });
      await page.goto("http://127.0.0.1:5199");
      await page
        .getByRole("button", {
          name: "Isolated fixture a, informational, unverified",
        })
        .click();
      await page
        .getByText("Private notes & corrections", { exact: true })
        .click();
      await page
        .getByLabel("Headline", { exact: true })
        .fill("Owner corrected headline");
      await page.getByLabel("Event start", { exact: true }).fill("2026-10-26");
      await page
        .getByLabel("Audit reason and source URL", { exact: true })
        .first()
        .fill("Correction supported by https://example.invalid/evidence");
      await page
        .getByRole("button", { name: "Save correction", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.body.textContent?.includes("Correction saved."),
      );
      assert.equal(writes[0].path, "/api/corrections");
      assert.equal(writes[0].body.patch.event_start, "2026-10-26");
      assert.equal(writes[0].body.expected_version, 3);
      await page.getByText("Incident reconstruction", { exact: true }).click();
      await page.getByText("Merge incidents", { exact: true }).click();
      await page.getByLabel("Merge with", { exact: true }).selectOption("b");
      await page
        .locator("#merge-reason")
        .fill("Same documented gathering from independent owner review");
      await page
        .getByRole("button", { name: "Merge with audit reason", exact: true })
        .click();
      await page.waitForTimeout(100);
      assert.deepEqual(
        writes.find((v) => v.path.endsWith("/merge"))?.body.ids,
        ["a", "b"],
      );
      await page.getByText("Split claims", { exact: true }).click();
      await page.locator("#split-claim-0").check();
      await page
        .locator("#split-reason")
        .fill("Two separately documented events in the report");
      await page
        .getByRole("button", { name: "Split selected claims", exact: true })
        .click();
      await page.waitForTimeout(100);
      assert.deepEqual(
        writes.find((v) => v.path.endsWith("/split"))?.body.claim_ids,
        ["c1"],
      );
      await page
        .getByRole("button", { name: "Back to activity", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Contextual controls", exact: true })
        .click();
      await page.locator("#source-filter").selectOption("fixture-source");
      await page.locator("#language-filter").selectOption("en");
      await page.locator("#evidence-filter").selectOption("unverified");
      page.once("dialog", (d: any) => d.accept("Complete filters"));
      await page
        .getByRole("button", { name: "Save this view", exact: true })
        .click();
      await page.locator("#source-filter").selectOption("");
      await page
        .getByRole("button", { name: "Complete filters", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Contextual controls", exact: true })
        .click();
      assert.equal(
        await page.locator("#source-filter").inputValue(),
        "fixture-source",
      );
      assert.equal(await page.locator("#language-filter").inputValue(), "en");
      assert.equal(
        await page.locator("#evidence-filter").inputValue(),
        "unverified",
      );
      await page
        .getByRole("button", { name: "Private areas", exact: true })
        .click();
      await page
        .getByLabel("Area name", { exact: true })
        .fill("Private test area");
      await page
        .getByLabel("Area bounds (west, south, east, north)", { exact: true })
        .fill("-1,50,1,52");
      await page
        .getByRole("button", { name: "Save private area", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Use this area in the feed", exact: true })
        .click();
      await page.waitForTimeout(100);
      assert.ok(decodeURIComponent(snapshotQuery).includes("bbox=-1,50,1,52"));
      assert.ok(!page.url().includes("-1%2C50"));
      await page
        .getByRole("button", { name: "Contextual controls", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Source health", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Retry analysis", exact: true })
        .click();
      await page.waitForTimeout(100);
      assert.ok(writes.some((v) => v.path === "/api/jobs/j1/retry"));
      await page
        .getByRole("button", { name: "Contextual controls", exact: true })
        .click();
      await page
        .getByLabel("Interface language", { exact: true })
        .selectOption("it");
      await page
        .getByRole("heading", { name: "Esplora e filtra", exact: true })
        .waitFor();
      assert.equal(await page.locator("html").getAttribute("lang"), "it");
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByRole("button", { name: "Torna alle attività", exact: true })
        .click();
      assert.equal(await page.locator("aside.panel").count(), 1);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      const pill = await page.locator(".health-pill").boundingBox();
      assert.ok(
        pill && pill.x + pill.width <= 390,
        "Italian compact status fits mobile width",
      );
      assert.ok(
        (await page
          .getByRole("button", { name: "Fonti", exact: true })
          .count()) === 0,
      );
      assert.ok(
        !writes.some(
          (v) =>
            ![
              "/api/corrections",
              "/api/incidents/merge",
              "/api/incidents/split",
              "/api/jobs/j1/retry",
            ].includes(v.path),
        ),
      );
    } finally {
      if (browser) await browser.close();
      server.kill("SIGTERM");
    }
  },
);

test("explicit event intervals override contradictory model temporal labels without inventing event hours", async () => {
  const { temporalStatus } = await import("../src/shared/temporal");
  const c: any = {
    event_start: "2026-10-12",
    event_end: "2026-12-06",
    temporal_status: "historical",
  };
  assert.equal(
    temporalStatus(c, Date.parse("2026-10-21T10:00:00Z")),
    "current",
  );
  assert.equal(
    temporalStatus(c, Date.parse("2026-10-01T10:00:00Z")),
    "planned",
  );
  assert.equal(
    temporalStatus(c, Date.parse("2026-12-07T10:00:00Z")),
    "historical",
  );
  assert.equal(
    temporalStatus(
      { ...c, event_end: null, temporal_status: "unknown" },
      Date.parse("2026-10-21T10:00:00Z"),
    ),
    "unknown",
  );
});
