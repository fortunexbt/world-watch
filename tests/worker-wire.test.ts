import test from "node:test";
import assert from "node:assert/strict";
import { compactInputs } from "../src/worker/wire.js";
import type { JobInput } from "../src/shared/contracts.js";
import { ANALYST, PROMPT_VERSION } from "../src/worker/analyst.js";
const facts = {
  event_title: "Peaceful assembly in Berlin",
  event_start_local: "2026-10-22T14:00:00",
  event_end_local: "2026-10-22T16:00:00",
  timezone: "Europe/Berlin",
  public_locations: [
    {
      city: "Berlin",
      street: "Alexanderplatz",
      country: "Germany",
      sequence: 1,
    },
  ],
  public_location_count: 1,
  public_locations_omitted: 0,
  raw_public_location: "Alexanderplatz, Berlin",
  raw_public_location_truncated: false,
  publisher_generated: true,
  notice:
    "Aggregator-extracted metadata, not independently confirmed. Planned assembly is not confirmed attendance or violence.",
  correction: "Route corrected: Alexanderplatz, not Potsdamer Platz.",
};
const metadata = {
  attribution: "Redundant attribution and licenseURL placeholder",
  license_url: "https://license.invalid/by-sa",
  upstream_reference: "https://reference.invalid/item",
  aggregator_record_created_at: "2026-10-20T12:00:00Z",
  aggregator_record_updated_at: "2026-10-21T13:00:00Z",
};
function input(
  source = "de-demos-assemblies",
  id = "licensed-event-metadata",
  text = JSON.stringify({ ...facts, ...metadata }),
): JobInput {
  return {
    source_id: source,
    native_id: "1",
    source_event_id: "episode1",
    canonical_url: "https://publisher.invalid/item",
    title: facts.event_title,
    original_language: "de",
    published_at: null,
    source_updated_at: metadata.aggregator_record_updated_at,
    input_coverage: "permitted_excerpt",
    excerpts: [{ id, text }],
    report_id: "host-report",
    content_revision: "host-revision",
    contract_version: "ew-1",
    first_observed_at: "2026-10-21T13:00:00Z",
    ingested_at: "2026-10-21T13:00:00Z",
  };
}
test("known Demos wire omits only redundant envelope, retains every event fact/correction and leaves stored evidence intact", () => {
  const source = input(),
    before = JSON.stringify(source),
    report = compactInputs([source]).reports[0];
  assert.deepEqual(JSON.parse(report.excerpts[0].text), facts);
  assert.equal(report.excerpts[0].id, "licensed-event-metadata");
  assert(!("updated" in report));
  assert.equal(JSON.stringify(source), before);
  for (const value of Object.values(metadata))
    assert(!JSON.stringify(report).includes(value));
  assert.equal(
    JSON.parse(source.excerpts[0].text).attribution,
    metadata.attribution,
  );
});
test("other sources, excerpt shapes, malformed or unstructured text are not stripped", () => {
  for (const source of [
    input("another-source"),
    input("de-demos-assemblies", "body"),
    input(
      "de-demos-assemblies",
      "licensed-event-metadata",
      "Correction: attribution is a material quoted word; preserve the full body.",
    ),
    input(
      "de-demos-assemblies",
      "licensed-event-metadata",
      '{"attribution":"material standalone statement"}',
    ),
  ])
    assert.equal(
      compactInputs([source]).reports[0].excerpts[0].text,
      source.excerpts[0].text,
    );
  const report = compactInputs([input("another-source")]).reports[0];
  assert.equal(report.updated, metadata.aggregator_record_updated_at);
});
test("prompt includes displacement and classifies fires without inferring violence or harm", () => {
  assert.equal(PROMPT_VERSION, "analyst-11-geospatial-displacement");
  assert.match(ANALYST, /displacement/);
  assert.match(
    ANALYST,
    /property_damage_fire for fire reports, not reported_violence/,
  );
  assert.match(ANALYST, /infer neither intent, violence nor property damage/);
});

test("known IDMC flow wire drops provenance envelope without losing qualifiers, aggregate scope or uncertainty", () => {
  const flow = {
    displacement_type: "Disaster",
    qualifier: "at least",
    figure: 750,
    figure_role: "new displacements",
    displacement_started_on: "2026-10-19",
    displacement_ended_on: "2026-10-20",
    locations: "Odesa; Mykolaiv",
    locations_truncated: false,
    location_accuracy: "regional",
    location_role: "origin",
    event_name: "Flood",
    reported_cause: "Flood",
    source_publishers: "IDMC source publishers retained",
    notice:
      "Provisional aggregate flow estimate; not live movement or independent headcount. May overlap; do not sum.",
    correction: "Revised estimate from 1000 to at least750.",
  };
  const envelope = {
    record_id: "private-operational-id",
    upstream_event_id: "private-upstream-id",
    source_record_created_at: "2026-10-21T12:13:14Z",
    upstream_reference: "https://reference.invalid/flow",
    attribution: "Original IDMC license attribution",
  };
  const source = input(
      "ua-idmc-displacement-flows",
      "licensed-flow-metadata",
      JSON.stringify({ ...flow, ...envelope }),
    ),
    before = JSON.stringify(source);
  const report = compactInputs([source]).reports[0];
  assert.deepEqual(JSON.parse(report.excerpts[0].text), flow);
  assert.equal(JSON.stringify(source), before);
  for (const value of Object.values(envelope))
    assert(!JSON.stringify(report).includes(value));
  const other = input(
    "other-flow",
    "licensed-flow-metadata",
    source.excerpts[0].text,
  );
  assert.equal(
    compactInputs([other]).reports[0].excerpts[0].text,
    other.excerpts[0].text,
  );
});
