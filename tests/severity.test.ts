import test from "node:test";
import assert from "node:assert/strict";
import { validateResult, type JobInput } from "../src/shared/contracts.js";

function fixture(text: string, opts: { official?: JobInput["official"] } = {}) {
  const input: JobInput = {
    source_id: "fixture-source",
    native_id: "item-1",
    canonical_url: "https://example.invalid/item-1",
    title: "Fixture report",
    original_language: "en",
    published_at: null,
    source_updated_at: null,
    input_coverage: "permitted_excerpt",
    excerpts: [{ id: "e1", text }],
    official: opts.official,
    report_id: "report-1",
    content_revision: "revision-1",
    contract_version: "ew-1",
    first_observed_at: "2026-10-21T12:00:00Z",
    ingested_at: "2026-10-21T12:00:00Z",
  };
  const result = {
    report_id: input.report_id,
    content_revision: input.content_revision,
    input_coverage: input.input_coverage,
    original_language: "en",
    relevant: true,
    relevance_reason: "The report describes an event.",
    summary_en: "A source report describes an event.",
    summary_it: null,
    published_at: input.published_at,
    source_updated_at: input.source_updated_at,
    claims: [{
      id: "claim-1",
      activity: "reported_violence" as const,
      summary: "The report describes an event.",
      evidence_ids: ["e1"],
      places: [],
      event_start: null,
      event_end: null,
      timezone: null,
      temporal_status: "unknown" as const,
      time_uncertainty: null,
      impacts: ["14 people injured"],
      violence_mentioned: "yes" as const,
      impact: "severe" as const,
      impact_uncertainty: null,
      official_instruction: null,
      relationships: [],
    }],
    candidate_incident_ids: [],
    uncertainty_flags: [],
    targeted_review: false,
  };
  return { input, result };
}

function withClaim(text: string, update: Record<string, unknown> = {}, options: { official?: JobInput["official"] } = {}) {
  const { input, result } = fixture(text, options);
  Object.assign(result.claims[0], update);
  return validateResult(result, input);
}

test("explicit cited public-order consequences still support severe impact", () => {
  assert.doesNotThrow(() => withClaim("Police said 14 people were injured during the clash.", { impacts: ["14 people were injured"] }));
});

test("a violence flag alone does not support severe impact", () => {
  assert.throws(() => withClaim("A clash was reported in the city.", { impacts: [] }), /unsupported_escalation/);
});

test("nonviolent fire and displacement can reach high impact with explicit cited consequences", () => {
  assert.doesNotThrow(() => withClaim(
    "The wildfire destroyed 120 homes and forced 400 residents to evacuate.",
    { activity: "property_damage_fire", violence_mentioned: "no", impacts: ["destroyed 120 homes"], impact: "severe" },
  ));
  assert.doesNotThrow(() => withClaim(
    "A catastrophic flood displaced 800 residents.",
    { activity: "displacement", violence_mentioned: "no", impacts: ["catastrophic flood displaced 800 residents"], impact: "critical" },
  ));
});

test("activity switching cannot create fire or displacement severity without matching consequences", () => {
  assert.throws(() => withClaim(
    "A peaceful march took place in the city.",
    { activity: "displacement", violence_mentioned: "no", impacts: ["peaceful march"] },
  ), /unsupported_escalation/);
});

test("negative, hypothetical, exercise, and uncited consequences do not support escalation", () => {
  for (const text of [
    "No injuries were reported and no evacuation was needed.",
    "The fire could cause injuries and might require evacuation.",
    "The evacuation was part of a school exercise and simulation.",
  ]) {
    assert.throws(() => withClaim(text, { activity: "property_damage_fire", violence_mentioned: "no", impacts: [text] }), /unsupported_escalation/);
  }
  const { input, result } = fixture("A peaceful march took place.");
  input.excerpts.push({ id: "e2", text: "Last year, 800 residents were displaced by floods." });
  Object.assign(result.claims[0], { activity: "displacement", violence_mentioned: "no", impacts: ["800 residents were displaced"] });
  assert.throws(() => validateResult(result, input), /unsupported_escalation/);
});

test("a quoted consequence subspan keeps its full clause negation and modality", () => {
  for (const [text, impact] of [
    ["No people were injured.", "people were injured"],
    ["The fire could have destroyed 120 homes.", "destroyed 120 homes"],
    ["The fire drill destroyed 120 homes.", "destroyed 120 homes"],
    ["No people were injured at one site. Separately, 14 people were injured at another.", "people were injured"],
  ]) {
    assert.throws(() => withClaim(text, { activity: "property_damage_fire", violence_mentioned: "no", impacts: [impact] }), /unsupported_escalation/);
  }
  assert.doesNotThrow(() => withClaim(
    "The fire destroyed 120 homes.",
    { activity: "property_damage_fire", violence_mentioned: "no", impacts: ["destroyed 120 homes"] },
  ));
});

test("high impact requires grounded claim-local impact text, not a citation borrowed from another excerpt", () => {
  const { input, result } = fixture("The city council met on Tuesday.");
  input.excerpts.push({ id: "e2", text: "A separate source says 800 residents were displaced last year." });
  Object.assign(result.claims[0], { activity: "displacement", evidence_ids: ["e1"], violence_mentioned: "no", impacts: ["800 residents were displaced"] });
  assert.throws(() => validateResult(result, input), /unsupported_escalation/);
});

test("a cited, actionable source instruction needs exact text and matching trusted source context", () => {
  const official = { issuer: "Regional Authority", effective_at: "2026-10-21T11:00:00Z", expires_at: "2026-10-21T18:00:00Z" };
  const { input, result } = fixture("The Regional Authority ordered residents to evacuate immediately.", { official });
  Object.assign(result.claims[0], {
    activity: "official_advisory",
    violence_mentioned: "no",
    impacts: ["evacuate immediately"],
    official_instruction: {
      issuer: "Regional Authority",
      instruction: "evacuate immediately",
      effective_at: official.effective_at,
      expires_at: official.expires_at,
      evidence_ids: ["e1"],
    },
  });
  assert.doesNotThrow(() => validateResult(result, input));
  assert.throws(() => withClaim(
    "The Regional Authority issued a routine notice.",
    { activity: "official_advisory", violence_mentioned: "no", impacts: ["routine notice"], official_instruction: { issuer: "Regional Authority", instruction: "", effective_at: null, expires_at: null, evidence_ids: [] } },
    { official: { issuer: "Regional Authority", effective_at: null, expires_at: null } },
  ), /unsupported_escalation/);
});

test("unclassified claims cannot escalate, and critical requires explicit scale evidence", () => {
  assert.throws(() => withClaim("14 people were injured.", { activity: "other_unknown", impacts: ["14 people were injured"] }), /unsupported_escalation/);
  assert.throws(() => withClaim("800 residents were displaced.", { activity: "displacement", impacts: ["800 residents were displaced"], impact: "critical" }), /unsupported_escalation/);
  assert.doesNotThrow(() => withClaim("A catastrophic flood displaced 800 residents.", { activity: "displacement", impacts: ["catastrophic flood displaced 800 residents"], impact: "critical", violence_mentioned: "no" }));
  const official = { issuer: "Regional Authority", effective_at: null, expires_at: null };
  assert.throws(() => withClaim(
    "The Regional Authority ordered residents to evacuate immediately.",
    { activity: "official_advisory", impacts: ["evacuate immediately", "thousands of residents"], impact: "critical", violence_mentioned: "no", official_instruction: { issuer: official.issuer, instruction: "evacuate immediately", effective_at: null, expires_at: null, evidence_ids: ["e1"] } },
    { official },
  ), /unsupported_escalation/);
});

test("a matching official directive supports severe impact without a stated consequence", () => {
  const official = { issuer: "Regional Authority", effective_at: null, expires_at: null };
  const claim = {
    activity: "official_advisory",
    violence_mentioned: "no",
    impacts: ["stay indoors"],
    official_instruction: { issuer: "Regional Authority", instruction: "stay indoors", effective_at: null, expires_at: null, evidence_ids: ["e1"] },
  };
  assert.doesNotThrow(() => withClaim("The Regional Authority told residents to stay indoors.", claim, { official }));
  assert.throws(() => withClaim("The Regional Authority told residents to stay indoors.", claim), /unsupported_escalation/);
  assert.throws(() => withClaim("Residents may need to stay indoors later.", claim, { official }), /unsupported_escalation/);
});
