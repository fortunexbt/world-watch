import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertDecision,
  alertMaterialityProjection,
  alertMaterialityVersion,
  intersects,
} from "../src/server/alerts";
import type { IncidentView } from "../src/shared/contracts";

const view = {
  id: "i",
  version: 1,
  headline: "Official urgent restriction",
  summary_en: "Restriction",
  summary_it: null,
  activity: "official_advisory",
  impact: "severe",
  evidence_status: "official_advisory",
  location: {
    name: "Paris",
    country: "FR",
    lon: 2.35,
    lat: 48.85,
    accuracy: "city",
    radius_km: 10,
  },
  event_start: "2026-10-21T10:00:00Z",
  event_end: null,
  published_at: null,
  ingested_at: "2026-10-21T10:00:00Z",
  analyzed_at: null,
  updated_at: "2026-10-21T10:00:00Z",
  expires_at: "2026-10-21T20:00:00Z",
  claims: [],
  reports: [],
  history: [],
  review_needed: false,
  cancelled: false,
} as IncidentView;
const time = new Date("2026-10-21T12:00:00Z");
const rule = { watch_area_id: "home" };
const geometry = { bbox: [2.4, 48.8, 2.45, 48.9] };

test("location uncertainty intersects watch area without claiming precise danger", () => {
  assert.ok(intersects(view.location, geometry));
  const decision = alertDecision(view, rule, geometry, null, time);
  assert.equal(decision.state, "eligible_ui");
  assert.match(decision.reason, /broad_area/);
});

test("unknown actionability, expired alerts and unsupported urgency suppress", () => {
  assert.equal(
    alertDecision({ ...view, event_start: null, expires_at: null }, {}, null, null, time).reason,
    "actionability_time_unknown",
  );
  assert.equal(
    alertDecision({ ...view, expires_at: "2020-01-01T00:00:00Z" }, {}, null, null, time).reason,
    "expired",
  );
  assert.equal(
    alertDecision({ ...view, evidence_status: "unverified" }, {}, null, null, time).reason,
    "insufficient_supported_evidence",
  );
  assert.equal(
    alertDecision({ ...view, impact: "minor" }, {}, null, null, time).reason,
    "no_current_urgent_claim",
  );
});

test("quiet hours and cooldown suppress, while the last delivered version suppresses duplicates", () => {
  assert.equal(
    alertDecision(view, { quiet_hours: { start: 13, end: 16, timezone: "Europe/Rome" } }, null, null, time).reason,
    "quiet_hours",
  );
  assert.equal(
    alertDecision(view, { cooldown_minutes: 15 }, null, { created_at: "2026-10-21T11:59:00Z" }, time).reason,
    "cooldown",
  );
  assert.equal(
    alertDecision(view, rule, geometry, { material_version: alertMaterialityVersion(view, rule) }, time).reason,
    "no_material_change",
  );
});

test("projection ignores cosmetic copy and metadata churn but tracks instructions, geometry, time and evidence", () => {
  const baseClaim = {
    id: "claim-a",
    activity: "official_advisory",
    summary: "Restriction announced",
    evidence_ids: ["e1"],
    places: [],
    event_start: "2026-10-21T10:00:00Z",
    event_end: null,
    timezone: "UTC",
    temporal_status: "current",
    time_uncertainty: null,
    impacts: ["access_restricted"],
    violence_mentioned: "no",
    impact: "severe",
    impact_uncertainty: null,
    official_instruction: {
      issuer: "City",
      instruction: "Avoid the central square",
      effective_at: "2026-10-21T10:00:00Z",
      expires_at: null,
      evidence_ids: ["e1"],
    },
    relationships: [],
  } as const;
  const base = { ...view, claims: [baseClaim] } as unknown as IncidentView;
  const copyOnly = {
    ...base,
    version: 99,
    headline: "A new cosmetic headline",
    summary_en: "Different summary prose",
    updated_at: "2026-10-21T11:59:00Z",
    claims: [{ ...baseClaim, id: "renumbered", summary: "Other prose", evidence_ids: ["new-evidence-id"] }],
  } as unknown as IncidentView;
  assert.deepEqual(alertMaterialityProjection(base, rule), alertMaterialityProjection(copyOnly, rule));
  assert.equal(alertMaterialityVersion(base, rule), alertMaterialityVersion(copyOnly, rule));

  const changedInstruction = {
    ...base,
    claims: [{ ...baseClaim, official_instruction: { ...baseClaim.official_instruction, instruction: "Use the east entrance" } }],
  } as unknown as IncidentView;
  const moved = { ...base, location: { ...view.location, lon: 3.35 } } as IncidentView;
  const retimed = { ...base, event_start: "2026-10-21T11:00:00Z" } as IncidentView;
  const changedEvidence = { ...base, evidence_status: "unverified" } as IncidentView;
  const dateOnly = { ...base, event_start: "2026-10-21" } as IncidentView;
  const midnight = { ...base, event_start: "2026-10-21T00:00:00Z" } as IncidentView;
  for (const changed of [changedInstruction, moved, retimed, changedEvidence])
    assert.notEqual(alertMaterialityVersion(base, rule), alertMaterialityVersion(changed, rule));
  assert.notEqual(alertMaterialityVersion(dateOnly, rule), alertMaterialityVersion(midnight, rule));
});

test("cancellation/retraction reaches prior eligible recipients despite changed area and cooldown", () => {
  const decision = alertDecision(
    { ...view, cancelled: true, location: null },
    { ...rule, enabled: false, quiet_hours: { start: 0, end: 24, timezone: "UTC" } },
    null,
    { created_at: "2026-10-21T11:59:00Z", material_version: alertMaterialityVersion(view, rule) },
    time,
  );
  assert.equal(decision.state, "eligible_ui");
  assert.match(decision.reason, /correction/);
});

test("a first-time cancellation is silent and previous state alone is not delivery proof", () => {
  assert.equal(alertDecision({ ...view, cancelled: true }, {}, null, null, time).state, "suppressed");
  assert.equal(
    alertDecision({ ...view, cancelled: true }, {}, null, { state: "suppressed" }, time).state,
    "suppressed",
  );
});

test("cancellation changes materiality and the same correction version is deduplicated", () => {
  const cancelled = { ...view, cancelled: true } as IncidentView;
  const delivered = {
    state: "eligible_ui",
    material_version: alertMaterialityVersion(view, rule),
  };
  const correction = alertDecision(cancelled, rule, null, delivered, time);
  assert.equal(correction.state, "eligible_ui");
  assert.match(correction.reason, /correction/);

  const repeated = alertDecision(
    cancelled,
    rule,
    null,
    { ...delivered, material_version: alertMaterialityVersion(cancelled, rule) },
    time,
  );
  assert.equal(repeated.state, "suppressed");
  assert.equal(repeated.reason, "no_material_change");
});

test("a location update that leaves the watch area corrects its prior recipient", () => {
  const moved = {
    ...view,
    location: { ...view.location!, lon: 20, lat: 20 },
  } as IncidentView;
  const decision = alertDecision(
    moved,
    rule,
    geometry,
    { material_version: alertMaterialityVersion(view, rule), created_at: "2026-10-21T11:59:00Z" },
    time,
  );
  assert.equal(decision.state, "eligible_ui");
  assert.match(decision.reason, /correction/);
});

test("changed versions that no longer meet a rule filter correct prior recipients", () => {
  const changed = { ...view, impact: "minor" } as IncidentView;
  const decision = alertDecision(
    changed,
    { impacts: ["severe"] },
    null,
    { material_version: alertMaterialityVersion(view, { impacts: ["severe"] }) },
    time,
  );
  assert.equal(decision.state, "eligible_ui");
  assert.match(decision.reason, /correction/);
});

test("ended, future and first-time retractions cannot trigger urgent notices", () => {
  assert.equal(
    alertDecision({ ...view, event_end: "2026-10-21T11:00:00Z" }, {}, null, null, time).reason,
    "event_ended",
  );
  assert.equal(
    alertDecision({ ...view, event_start: "2026-10-23T10:00:00Z" }, {}, null, null, time).reason,
    "future_event",
  );
  assert.equal(alertDecision({ ...view, cancelled: true }, {}, null, null, time).state, "suppressed");
});
