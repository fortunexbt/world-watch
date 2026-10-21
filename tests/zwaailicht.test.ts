import test from "node:test";
import assert from "node:assert/strict";
import {
  parseZwaailicht,
  zwaailichtEligibleTitle,
  zwaailichtQueryURL,
} from "../src/collector/adapters/zwaailicht.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { collectSources, sourceEligibility } from "../src/collector/index.js";
const source = sourceRegistry.find(
  (s) => s.id === "nl-zwaailicht-fire-clusters",
)!;
// Fully synthetic dispatch clusters; no retained live alarm identifiers or incident descriptions.
const first = {
  id: "00000000-0000-4000-8000-000000000003",
  type: "incident",
  title: "Brand woning — synthetische parserfixture Utrecht",
  started_at: "2026-10-21T08:00:00Z",
  ended_at: "2026-10-21T08:15:00Z",
  active: false,
  location: { city: "Utrecht", latitude: 52.09, longitude: 5.12 },
  alert_count: 6,
  _links: { html: "/pieken/utrecht/2026-10-21/fixture-000003" },
};
const payload = {
  results: [first],
  license: {
    holder: "Zwaailicht.nl",
    terms: "https://zwaailicht.nl/voorwaarden",
  },
};
test("synthetic publisher-shaped cluster preserves native identity, source link and unconfirmed provenance without invented event-end", () => {
  const row = parseZwaailicht(source, payload)[0];
  assert.equal(row.source_event_id, first.id);
  assert.equal(row.native_id, first.id);
  assert.equal(
    row.canonical_url,
    "https://zwaailicht.nl/pieken/utrecht/2026-10-21/fixture-000003",
  );
  assert.equal(row.source_metadata?.alarm_count, 6);
  assert.equal(row.source_metadata?.publisher_generated, true);
  assert.equal(row.published_at, null);
  assert.equal(row.official, undefined);
  assert.equal(row.input_coverage, "permitted_excerpt");
  assert.match(
    row.excerpts[0].text,
    /Publisher-generated interpretation of a public dispatch/,
  );
  assert.match(row.excerpts[0].text, /not independent corroboration/);
  assert(!row.excerpts[0].text.includes(first.ended_at));
  assert(!row.excerpts[0].text.includes("alarm_count"));
});
test("alarm-count and last-alarm-only updates do not change substantive evidence", () => {
  const a = parseZwaailicht(source, payload)[0];
  const b = parseZwaailicht(source, {
    ...payload,
    results: [
      {
        ...first,
        alert_count: 7,
        ended_at: "2026-10-21T08:45:00Z",
        active: true,
      },
    ],
  })[0];
  assert.deepEqual(a.excerpts, b.excerpts);
  assert.equal(a.title, b.title);
  assert.equal(a.source_event_id, b.source_event_id);
  assert.notEqual(
    a.source_metadata?.alarm_count,
    b.source_metadata?.alarm_count,
  );
  assert.notEqual(a.source_updated_at, b.source_updated_at);
});
test("contradictory publisher coordinates are never promoted to an event point or a guessed city center", () => {
  const row = parseZwaailicht(source, {
    ...payload,
    results: [
      {
        ...first,
        title: "Gebouwbrand in Amsterdam",
        location: { city: "Amsterdam", latitude: 51.5, longitude: 4.5 },
      },
    ],
  })[0];
  assert.equal(row.source_geo, undefined);
  assert.match(row.excerpts[0].text, /Amsterdam/);
  assert(!row.excerpts[0].text.includes("51.5"));
});
test("visible source backlink and publisher-specific grant are required; raw/tactical fields are ignored", () => {
  assert.throws(
    () => parseZwaailicht(source, { results: [first] }),
    /reuse_grant/,
  );
  assert.deepEqual(
    parseZwaailicht(source, {
      ...payload,
      results: [
        { ...first, _links: { html: "https://elsewhere.example/claim" } },
      ],
    }),
    [],
  );
  const row = parseZwaailicht(source, {
    ...payload,
    results: [
      {
        ...first,
        units: ["private tactical identifier"],
        source: { original_text: "raw pager private payload" },
      },
    ],
  })[0];
  assert(!JSON.stringify(row).includes("private tactical"));
  assert(!JSON.stringify(row).includes("private payload"));
});
test("routine alarms, exercises and medical/private-person noise are excluded while explicit public fire signal is admitted", () => {
  for (const title of [
    "Automatische brandmelding Schiphol",
    "Oefening brandweer",
    "Nacontrole brand",
    "Reanimatie in woning",
  ]) {
    assert.equal(zwaailichtEligibleTitle(title), false);
    assert.equal(
      sourceEligibility(
        source,
        { ...parseZwaailicht(source, payload)[0], title },
        Date.parse("2026-10-21T12:00:00Z"),
      ).eligible,
      false,
    );
  }
  assert.equal(
    sourceEligibility(
      source,
      parseZwaailicht(source, payload)[0],
      Date.parse("2026-10-21T12:00:00Z"),
    ).eligible,
    true,
  );
  assert.equal(
    sourceEligibility(
      source,
      parseZwaailicht(source, payload)[0],
      Date.parse("2026-10-23T12:00:00Z"),
    ).eligible,
    false,
  );
});
test("collector fetches only a bounded rolling24h cluster list without following bulk cursors", async () => {
  let fetches = 0;
  const accepted: any[] = [];
  const at = Date.parse("2026-10-21T12:00:00Z");
  await collectSources(
    { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "fixture" },
    {
      sources: [source],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async () => {},
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      now: () => at,
      maxRequests: 20,
      fetch: async (url) => {
        fetches++;
        const u = new URL(String(url));
        assert.equal(u.href, zwaailichtQueryURL(at));
        assert.equal(u.searchParams.get("limit"), "30");
        assert.equal(u.searchParams.get("from"), "2026-10-20T12:00:00.000Z");
        return Response.json({
          ...payload,
          pagination: { next: "https://zwaailicht.nl/do-not-follow-archive" },
        });
      },
    },
  );
  assert.equal(fetches, 1);
  assert.equal(accepted.length, 1);
  assert(source.poll_seconds >= 60);
  assert.equal(source.rights.retention_days, 7);
  assert.equal(source.rights.redistribute, false);
});
