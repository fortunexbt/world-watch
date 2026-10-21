import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
test(
  "default SSE patches scoped incidents without full snapshots, preserves reading and stops hidden reads",
  { timeout: 60000 },
  async () => {
    const server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        "5198",
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
    let browser: any;
    try {
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch("http://127.0.0.1:5198")).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.clock.install();
      await page.addInitScript({
        content: `
        window.__hidden=false; window.__streams=[];
        Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__hidden});
        window.EventSource=class {
          constructor(url){this.url=url;this.closed=false;this.listeners={};window.__streams.push(this);setTimeout(()=>this.onopen?.(),0)}
          addEventListener(k,v){(this.listeners[k]??=[]).push(v)}
          close(){this.closed=true}
          emit(k,data,cursor){if(this.closed)throw Error('closed_stream');for(const f of this.listeners[k]??[])f(new MessageEvent(k,{data:JSON.stringify(data),lastEventId:String(cursor)}))}
        };
      `,
      });
      let snapshots = 0,
        details = 0, briefs = 0;
      const incident = (id: string, version = 1, extra: any = {}) => ({
        id,
        version,
        headline: "Fixture " + id + " v" + version,
        summary_en: "Isolated source-backed fixture.",
        summary_it: null,
        activity: "gathering",
        impact: "informational",
        evidence_status: "unverified",
        location: null,
        event_start: null,
        event_end: null,
        published_at: null,
        ingested_at: new Date().toISOString(),
        analyzed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: null,
        claims: [],
        reports: [],
        history: [],
        review_needed: false,
        cancelled: false,
        ...extra,
      });
      const records: Record<string, any> = { seed: incident("seed") };
      let releaseRace: () => void = () => {};
      const raceWait = new Promise<void>((r) => (releaseRace = r));
      await page.route("**/*", async (route: any) => {
        const u = new URL(route.request().url());
        if (u.pathname === "/src/client/Map.tsx")
          return route.fulfill({
            contentType: "text/javascript",
            body: `export const colors={informational:'#69c',minor:'#fc6',significant:'#fa6',severe:'#f77',critical:'#f44',unknown:'#aaa'};export default function Map(p){window.__mapBounds=p.onBounds;window.__pulses??=[];if(p.pulse!==window.__lastPulse){window.__lastPulse=p.pulse;if(p.pulse?.length)window.__pulses.push([...p.pulse]);}return null}`,
          });
        if (u.pathname === "/api/brief") {
          briefs++;
          return route.fulfill({json:{current:null,pending:false}});
        }
        if (u.pathname === "/api/snapshot") {
          snapshots++;
          await new Promise((r) => setTimeout(r, 20));
          return route.fulfill({
            json: {
              incidents: [records.seed],
              incoming: [],
              sources: [],
              status: { worker_state: "online", pending_count: 0 },
              cursor: "10",
            },
          });
        }
        if (u.pathname.startsWith("/api/incidents/")) {
          details++;
          const id = decodeURIComponent(u.pathname.split("/").pop()!);
          if (id === "race") await raceWait;
          if (records[id] === null)
            return route.fulfill({ status: 404, json: { error: "not_found" } });
          return route.fulfill({ json: records[id] });
        }
        if (u.pathname.startsWith("/api/"))
          throw Error("Unexpected API fixture " + u.pathname);
        if (u.hostname !== "127.0.0.1") return route.abort();
        return route.continue();
      });
      await page.goto("http://127.0.0.1:5198");
      await page
        .getByRole("heading", { name: "Fixture seed v1", exact: true })
        .waitFor();
      const initial = snapshots;
      assert.equal(initial, 1, "concurrent hydration calls coalesce");
      const emit = async (
        type: string,
        id: string,
        cursor: number,
        version = 1,
        catchup = false,
      ) =>
        page.evaluate(
          ({ type, id, cursor, version, catchup }: any) => {
            const stream = (window as any).__streams
              .filter((s: any) => !s.closed)
              .at(-1);
            stream.emit(type, { incident_id: id, version, catchup }, cursor);
          },
          { type, id, cursor, version, catchup },
        );
      for (let n = 1; n <= 3; n++) {
        const id = "new" + n;
        records[id] = incident(id);
        await emit("incident.created", id, 10 + n);
        await page
          .getByRole("heading", { name: "Fixture " + id + " v1", exact: true })
          .waitFor();
      }
      records.seed = incident("seed", 2);
      await emit("incident.updated", "seed", 14, 2);
      await page
        .getByRole("heading", { name: "Fixture seed v2", exact: true })
        .waitFor();
      records.old = incident("old", 1, {
        published_at: "2000-01-01T00:00:00Z",
      });
      await emit("incident.created", "old", 15);
      await page.waitForTimeout(30);
      assert.equal(
        await page
          .getByRole("heading", { name: "Fixture old v1", exact: true })
          .count(),
        0,
      );
      records.valid = incident("valid", 1, {
        published_at: "2000-01-01T00:00:00Z",
        expires_at: "2099-01-01T00:00:00Z",
      });
      await emit("incident.updated", "valid", 16);
      await page
        .getByRole("heading", { name: "Fixture valid v1", exact: true })
        .waitFor();
      await page.locator(".feed-list").hover();
      records.buffered = incident("buffered");
      await emit("incident.created", "buffered", 17);
      await page.getByRole("button", { name: /1 new updates/ }).waitFor();
      assert.equal(
        await page
          .getByRole("heading", { name: "Fixture buffered v1", exact: true })
          .count(),
        0,
      );
      await page.getByRole("button", { name: /1 new updates/ }).click();
      await page
        .getByRole("heading", { name: "Fixture buffered v1", exact: true })
        .waitFor();
      await emit("incident.deleted", "new1", 18, 2);
      await page
        .getByRole("heading", { name: "Fixture new1 v1", exact: true })
        .waitFor({ state: "detached" });
      records.race = incident("race");
      await emit("incident.created", "race", 19);
      await page.waitForTimeout(20);
      await emit("incident.deleted", "race", 20, 2);
      releaseRace();
      await page.waitForTimeout(50);
      assert.equal(
        await page
          .getByRole("heading", { name: "Fixture race v1", exact: true })
          .count(),
        0,
      );
      await page.clock.fastForward(1000);
      assert.equal(
        snapshots,
        initial,
        "eight incident deltas do not scan a full snapshot",
      );
      assert.equal(details, 8, "one scoped lookup per nondeleted delta");
      await page.evaluate(() => {
        (window as any).__mapBounds("1,2,3,4");
      });
      await page.waitForTimeout(30);
      assert.equal(
        snapshots,
        initial,
        "world-scope viewport motion does not refetch",
      );
      await page.mouse.move(1400, 20);
      records.dup = incident("dup", 2);
      await page.evaluate(() => {
        const stream = (window as any).__streams
          .filter((s: any) => !s.closed)
          .at(-1);
        stream.emit("incident.created", { incident_id: "dup", version: 1 }, 21);
        stream.emit(
          "incident.escalated",
          { incident_id: "dup", version: 2 },
          22,
        );
      });
      await page
        .getByRole("heading", { name: "Fixture dup v2", exact: true })
        .waitFor();
      await page.clock.fastForward(500);
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).__pulses.filter((ids: string[]) =>
              ids.includes("dup"),
            ).length,
        ),
        1,
        "same returned incident/version cannot announce twice",
      );
      records.withdrawn = incident("withdrawn");
      await emit("incident.created", "withdrawn", 23);
      await page
        .getByRole("heading", { name: "Fixture withdrawn v1", exact: true })
        .waitFor();
      records.withdrawn = null;
      await emit("incident.updated", "withdrawn", 24, 2);
      await page
        .getByRole("heading", { name: "Fixture withdrawn v1", exact: true })
        .waitFor({ state: "detached" });
      await page.locator(".feed-list").hover();
      records.withheld = incident("withheld");
      await emit("incident.created", "withheld", 25);
      await page.getByRole("button", { name: /1 new updates/ }).waitFor();
      records.withheld = null;
      await emit("incident.updated", "withheld", 26, 2);
      await page
        .getByRole("button", { name: /1 new updates/ })
        .waitFor({ state: "detached" });
      assert.equal(
        await page
          .getByRole("heading", { name: "Fixture withheld v1", exact: true })
          .count(),
        0,
        "trusted404 removes buffered evidence too",
      );
      await page.evaluate(() => {
        (window as any).__hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(20);
      assert.equal(
        await page.evaluate(
          () => (window as any).__streams.filter((s: any) => !s.closed).length,
        ),
        0,
      );
      const beforeHidden = snapshots, briefsBeforeHidden = briefs;
      await page.clock.fastForward(65000);
      assert.equal(snapshots, beforeHidden, "no hidden-tab polling");
      assert.equal(briefs,briefsBeforeHidden,"no hidden-tab brief polling");
      await page.evaluate(() => {
        (window as any).__hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(100);
      assert.equal(
        snapshots,
        beforeHidden + 1,
        "visible resume performs one authoritative snapshot",
      );
      assert.equal(
        await page.evaluate(
          () => (window as any).__streams.filter((s: any) => !s.closed).length,
        ),
        1,
      );
      const makeClaim = (id: string, report_id?: string) => ({
        id,
        report_id,
        content_revision: report_id ? "rev1" : undefined,
        summary: "Claim " + id,
        evidence_ids: ["e1"],
        places: [],
        official_instruction: null,
        temporal_status: "current",
        violence_mentioned: "no",
        time_uncertainty: null,
        impact_uncertainty: null,
        impacts: [],
      });
      records.seed = {
        ...records.seed,
        claims: [
          makeClaim("first", "r1"),
          makeClaim("second", "r2"),
          makeClaim("legacy"),
        ],
        reports: [
          {
            report_id: "r1",
            content_revision: "rev1",
            title: "Source one",
            source_id: "fixture",
            original_language: "en",
            canonical_url: "https://example.invalid/one",
            excerpts: [{ id: "e1", text: "First source quotation." }],
          },
          {
            report_id: "r2",
            content_revision: "rev1",
            title: "Source two",
            source_id: "fixture",
            original_language: "en",
            canonical_url: "https://example.invalid/two",
            excerpts: [{ id: "e1", text: "Second source quotation." }],
          },
        ],
      };
      await page.getByRole("button", { name: /Fixture seed v2,/ }).click();
      await page
        .getByText("First source quotation.", { exact: true })
        .waitFor();
      const citationLinks = page.locator('.claim a[href^="#evidence-"]');
      assert.equal(
        await citationLinks.count(),
        2,
        "two namespaced claims cite their own reports; ambiguous legacy claim cannot borrow evidence",
      );
      const firstHref = await citationLinks.nth(0).getAttribute("href");
      const secondHref = await citationLinks.nth(1).getAttribute("href");
      assert.notEqual(
        firstHref,
        secondHref,
        "same excerpt ID from different reports is not conflated",
      );
      assert.equal(
        await page.locator('[id="' + firstHref!.slice(1) + '"]').innerText(),
        "First source quotation.",
      );
      assert.equal(
        await page.locator('[id="' + secondHref!.slice(1) + '"]').innerText(),
        "Second source quotation.",
      );
    } finally {
      await browser?.close();
      server.kill("SIGTERM");
    }
  },
);
