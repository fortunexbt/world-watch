import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDemos,
  DEMOS_READ_QUERY,
} from "../src/collector/adapters/demos.js";
import type { SourceRecord } from "../src/shared/contracts.js";
const source = { id: "de-demos-assemblies" } as SourceRecord;
// Fully synthetic event records matching the public API schema; never collected or published.
const event = {
  id: 900001,
  created: "2026-10-21T06:00:00Z",
  updated: "2026-10-21T06:00:00Z",
  name: "Friedliche Testversammlung — synthetisches Beispiel",
  slug: "900001--synthetische-testversammlung",
  description: "upstream full body must never be copied",
  url: "https://publisher.example/assemblies/fixture-1",
  start_time: "2026-10-23T18:00:00",
  end_time: "2026-10-23T19:00:00",
  timezone: "Europe/Berlin",
  locations: [
    {
      city: "Dresden",
      country: "Deutschland",
      street: "Fixture square",
      sequence: 0,
      geography: { type: "Point", coordinates: [13.75, 51.05] },
    },
  ],
  raw_location: "Fixture square",
  raw_organiser: "private individual",
  organizer_phone: "FIXTURE_PRIVATE_PHONE",
  is_llm_parsed: true,
  route_geography: { coordinates: Array(1000).fill([13, 51]) },
};
test("Demos retains licensed factual planned event metadata and provenance without official geometry", () => {
  const row = parseDemos(source, { events: [event] })[0],
    text = row.excerpts[0].text,
    meta = JSON.parse(text);
  assert.equal(row.native_id, "900001");
  assert.equal(row.source_event_id, "900001");
  assert.equal(row.published_at, null);
  assert.equal(row.source_updated_at, new Date(event.updated).toISOString());
  assert.equal(meta.event_start_local, event.start_time);
  assert.equal(meta.timezone, "Europe/Berlin");
  assert.equal(meta.public_locations[0].city, "Dresden");
  assert.equal(meta.upstream_reference, event.url);
  assert.equal(row.source_geo, undefined);
  assert.equal(row.official, undefined);
  assert.deepEqual(row.source_metadata, { publisher_generated: true });
  assert.match(meta.notice, /not independently confirmed/);
  assert.match(meta.attribution, /CC BY-SA 4.0/);
  assert.ok(!text.includes("upstream full body"));
  assert.ok(!text.includes("private individual"));
  assert.ok(!text.includes("FIXTURE_PRIVATE_PHONE"));
  assert.ok(!text.includes("13.75"));
  assert.ok(text.length < 3000);
});
test("Demos explicit restricted records excluded and invalid identifiers do not become events", () => {
  assert.equal(
    parseDemos(source, {
      events: [
        { ...event, rights_restricted: true },
        { ...event, reuse_allowed: false },
        { ...event, id: 900002 },
        { ...event, slug: "https://attacker.example" },
      ],
    }).length,
    0,
  );
});
test("Demos invalid dates cannot normalize, timezone unknown stays unknown", () => {
  assert.equal(
    parseDemos(source, {
      events: [{ ...event, start_time: "2026-02-30T18:30:00" }],
    }).length,
    0,
  );
  const row = parseDemos(source, {
    events: [
      { ...event, timezone: "Unknown/City", updated: "2026-02-30T18:30:00Z" },
    ],
  })[0];
  assert.equal(JSON.parse(row.excerpts[0].text).timezone, null);
  assert.equal(row.source_updated_at, null);
});
test("Demos bounds large routes/location lists and rejects pages beyond20", () => {
  const row = parseDemos(source, {
      events: [{ ...event, locations: Array(1000).fill(event.locations[0]) }],
    })[0],
    meta = JSON.parse(row.excerpts[0].text);
  assert.equal(meta.public_locations.length, 8);
  assert.equal(meta.public_locations_omitted, 992);
  assert.throws(
    () => parseDemos(source, { events: Array(21).fill(event) }),
    /invalid_demos_page/,
  );
  assert.equal(DEMOS_READ_QUERY.limit, 20);
});
test("Demos missing publisher-generation flag does not invent it", () => {
  assert.equal(
    parseDemos(source, { events: [{ ...event, is_llm_parsed: false }] })[0]
      .source_metadata?.publisher_generated,
    false,
  );
});
import { collectSources, sourceEligibility } from "../src/collector/index.js";
import { sourceRegistry } from "../src/collector/registry.js";
import { fetchSource } from "../src/collector/fetch.js";
import { DEMOS_QUERY_URL } from "../src/collector/adapters/demos.js";
test("Demos collector performs bounded read-only JSON query and admits peaceful planned assembly", async () => {
  const configured = sourceRegistry.find((s) => s.id === source.id)!;
  assert.ok(configured);
  const accepted: any[] = [];
  let health: any;
  let calls = 0;
  const result = await collectSources(
    { EW_API_URL: "https://isolated.invalid", EW_COLLECTOR_TOKEN: "fixture" },
    {
      sources: [configured],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async (_id, payload) => {
        health = payload;
      },
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), DEMOS_QUERY_URL);
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), DEMOS_READ_QUERY);
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        return Response.json({ events: [event] });
      },
      maxRequests: 20,
      now: () => Date.parse("2026-10-21T12:00:00Z"),
    },
  );
  assert.equal(result[0].status, "ok");
  assert.equal(calls, 1);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].eligibility.eligible, true);
  assert.equal(health.checkpoint.admission.admitted, 1);
  assert.equal(
    sourceEligibility(configured, accepted[0]).reason,
    "licensed_aggregator_planned_public_assembly",
  );
});
test("Demos POST query cannot be redirected or enabled on arbitrary approved hosts", async () => {
  let calls = 0;
  await assert.rejects(
    fetchSource(
      DEMOS_QUERY_URL,
      {},
      {
        demosQuery: true,
        fetch: async () => {
          calls++;
          return new Response(null, {
            status: 307,
            headers: {
              location: "https://api.demonstrations.org/v1/event/900001",
            },
          });
        },
      },
    ),
    /source_query_redirect_rejected/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchSource(
      "https://warnung.bund.de/api31/mowas/mapData.json",
      {},
      {
        demosQuery: true,
        fetch: async () => {
          throw Error("must_not_fetch");
        },
      },
    ),
    /unapproved_public_event_query/,
  );
});
