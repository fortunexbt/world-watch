import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCatalunyaBombers,
  CATALUNYA_BOMBERS_QUERY,
} from "../src/collector/adapters/catalunya-bombers.js";
import type { SourceRecord } from "../src/shared/contracts.js";
import { collectSources } from "../src/collector/index.js";
import { sourceRegistry } from "../src/collector/registry.js";
const source = { id: "es-cat-bombers" } as SourceRecord;
// Fully synthetic API-shaped records; public town names exercise source-supplied geography only.
const sample = {
  spatialReference: { wkid: 4326 },
  features: [
    {
      attributes: {
        GlobalID: "00000000-0000-4000-8000-000000000001",
        MUNICIPI_DPX: "Girona",
        TAL_DESC_ALARMA2: "Incendi vegetació urbana — exemple sintètic",
        ACT_DAT_INICI: 1792569600000,
        ACT_DAT_ACTUAL: 1792569603000,
        ACT_DAT_FI: null,
        ACT_SITUACIO: "I",
        COM_FASE: null,
      },
      geometry: { x: 2.82, y: 41.98 },
    },
    {
      attributes: {
        GlobalID: "00000000-0000-4000-8000-000000000002",
        MUNICIPI_DPX: "Lleida",
        TAL_DESC_ALARMA2: "Incendi vegetació agrícola — exemple sintètic",
        ACT_DAT_INICI: 1792566000000,
        ACT_DAT_ACTUAL: 1792566001000,
        ACT_DAT_FI: null,
        ACT_SITUACIO: "I",
      },
      geometry: { x: 0.62, y: 41.62 },
    },
  ],
};
test("two synthetic public-fire-shaped records preserve episode, source point and event/update time without invented publication/impact", () => {
  const rows = parseCatalunyaBombers(source, sample);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_event_id, sample.features[0].attributes.GlobalID);
  assert.equal(rows[0].published_at, null);
  assert.equal(rows[0].source_updated_at, "2026-10-21T08:00:03.000Z");
  assert.equal(rows[0].official?.effective_at, "2026-10-21T08:00:00.000Z");
  assert.equal(rows[0].source_geo?.name, "Girona");
  assert.equal(rows[0].source_geo?.lon, sample.features[0].geometry.x);
  assert.equal(rows[0].official?.expires_at, null);
  assert.match(
    rows[0].excerpts[0].text,
    /no end timestamp does not confirm ongoing/i,
  );
  assert(!rows[0].official?.cancelled);
});
test("public fire endpoint requests bounded records with geographic coordinates and excludes tactical vehicle/resource fields", () => {
  const u = new URL(CATALUNYA_BOMBERS_QUERY);
  assert.equal(u.searchParams.get("resultRecordCount"), "200");
  assert.equal(u.searchParams.get("outSR"), "4326");
  assert(!u.searchParams.get("outFields")?.includes("ACT_NUM_VEH"));
});
test("unknown coordinate system and impossible point never become guessed map locations", () => {
  assert.equal(
    parseCatalunyaBombers(source, {
      ...sample,
      spatialReference: { wkid: 3857 },
    })[0].source_geo,
    undefined,
  );
  const bad = structuredClone(sample);
  bad.features[0].geometry.x = 999;
  assert.equal(parseCatalunyaBombers(source, bad)[0].source_geo, undefined);
});
test("invalid API envelopes and pagination fail visibly; healthy empty returns no fabricated events", () => {
  assert.deepEqual(parseCatalunyaBombers(source, { features: [] }), []);
  assert.throws(
    () => parseCatalunyaBombers(source, { error: { code: 403 } }),
    /invalid_bombers_response/,
  );
  assert.throws(
    () =>
      parseCatalunyaBombers(source, { ...sample, exceededTransferLimit: true }),
    /pagination_required/,
  );
  const bad = structuredClone(sample);
  bad.features[0].attributes.GlobalID = "";
  assert.equal(parseCatalunyaBombers(source, bad).length, 1);
});
test("registry routes public Bombers JSON through dedicated parser and admits source episodes before generic filters", async () => {
  const configured = sourceRegistry.find((s) => s.id === "es-cat-bombers")!;
  const accepted: any[] = [];
  const result = await collectSources(
    {
      EW_API_URL: "https://isolated.invalid",
      EW_COLLECTOR_TOKEN: "isolated-fixture",
    },
    {
      sources: [configured],
      register: async () => {},
      checkpoint: async () => ({}),
      recordHealth: async () => {},
      ingest: async (rows) => {
        accepted.push(...rows);
      },
      fetch: async (url) => {
        assert.equal(String(url), CATALUNYA_BOMBERS_QUERY);
        return Response.json(sample);
      },
      maxRequests: 20,
      now: () => Date.parse("2026-10-21T11:30:00Z"),
    },
  );
  assert.equal(result[0].status, "ok");
  assert.equal(accepted.length, 2);
  assert(accepted.every((x) => x.eligibility.eligible));
  assert(
    accepted.every(
      (x) => x.eligibility.reason === "publisher_selected_public_fire_service",
    ),
  );
});
