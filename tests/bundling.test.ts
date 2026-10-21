import test from "node:test";
import assert from "node:assert/strict";
import { stableBundlePayload } from "../src/server/bundling.js";
import type {
  ObservationInput,
  SourceRecord,
} from "../src/shared/contracts.js";
const source = {
  id: "publisher",
  url: "https://official.example/feed",
  status: "enabled",
  rights: { access: true, storage: true, ai: true },
} as SourceRecord;
const input: ObservationInput = {
  source_id: "publisher",
  native_id: "one",
  canonical_url: "https://official.example/one",
  title: "Rail closure at Lyon",
  original_language: "fr",
  published_at: "2026-10-21T08:00:00Z",
  source_updated_at: null,
  input_coverage: "full_licensed_text",
  source_event_id: "native-episode-one",
  excerpts: [
    {
      id: "description",
      text: "Les circulations du tramway T1 à Lyon sont interrompues entre la gare et le centre-ville le 21 octobre 2026 en raison de travaux.",
    },
  ],
};
test("exact text on the same source day reuses across report IDs, URLs, whitespace and excerpt IDs", () => {
  const a = stableBundlePayload(input, source);
  assert(a);
  assert.equal(
    a,
    stableBundlePayload(
      {
        ...input,
        native_id: "two",
        canonical_url: "https://official.example/two",
        published_at: "2026-10-21T12:00:00Z",
        excerpts: [
          { id: "other", text: input.excerpts[0].text.replaceAll(" ", " \n ") },
        ],
      },
      source,
    ),
  );
  assert.equal(
    a,
    stableBundlePayload(
      {
        ...input,
        excerpts: [{ id: "title", text: input.title }, ...input.excerpts],
      },
      source,
    ),
  );
});
test("new facts, places, dates, language, official cancellation and source boundaries never share a bundle", () => {
  const a = stableBundlePayload(input, source);
  for (const patch of [
    {
      excerpts: [
        {
          id: "description",
          text: input.excerpts[0].text + " Correction: Lyon, pas Paris.",
        },
      ],
    },
    { title: "Rail closure at Paris" },
    { published_at: "2026-10-22T08:00:00Z" },
    { original_language: "en" },
    {
      source_geo: {
        lat: 45.75,
        lon: 4.85,
        name: "Lyon",
        accuracy: "city" as const,
      },
    },
    {
      official: {
        issuer: "Operator",
        effective_at: "2026-10-21T08:00:00Z",
        expires_at: "2026-10-21T18:00:00Z",
        cancelled: true,
      },
    },
    { source_event_id: "separate-official-episode" },
  ])
    assert.notEqual(a, stableBundlePayload({ ...input, ...patch }, source));
  assert.notEqual(
    a,
    stableBundlePayload(
      { ...input, source_id: "another" },
      { ...source, id: "another" },
    ),
  );
  assert.notEqual(
    a,
    stableBundlePayload(input, {
      ...source,
      url: "https://different.example/feed",
    }),
  );
});
test("unknown dates and short generic headings fall back to each report identity", () => {
  assert.equal(
    stableBundlePayload({ ...input, published_at: null }, source),
    null,
  );
  assert.equal(
    stableBundlePayload({ ...input, published_at: "2026-02-30" }, source),
    null,
  );
  assert.equal(
    stableBundlePayload(
      {
        ...input,
        title: "Plus d'information",
        excerpts: [
          {
            id: "validity",
            text: "Start: 2026-10-21T08:00:00Z; End: 2026-10-21T18:00:00Z",
          },
        ],
      },
      source,
    ),
    null,
  );
  assert.equal(
    stableBundlePayload({ ...input, input_coverage: "title_only" }, source),
    null,
  );
});
test("same publication day and identical prose cannot group unknown geography without a native episode anchor", () => {
  const unanchored = { ...input, source_event_id: undefined };
  assert.equal(stableBundlePayload(unanchored, source), null);
  assert.equal(
    stableBundlePayload(
      { ...unanchored, native_id: "another-city-with-identical-boilerplate" },
      source,
    ),
    null,
  );
  assert.equal(
    stableBundlePayload(
      {
        ...unanchored,
        title: "Train delayed",
        excerpts: [
          {
            id: "description",
            text: "Generic service interruption; please check the timetable and operator website for additional information.",
          },
        ],
      },
      source,
    ),
    null,
  );
  const geo = {
    ...unanchored,
    source_geo: {
      lat: 45.75,
      lon: 4.85,
      name: "Lyon",
      accuracy: "city" as const,
    },
    official: {
      issuer: "Operator",
      effective_at: "2026-10-21T08:00:00Z",
      expires_at: null,
    },
  };
  assert(stableBundlePayload(geo, source));
});
test("SIRI native route references require full source validity and preserve distinct affected stops", () => {
  const siriSource = { ...source, family: "siri" as const };
  const siri = {
    ...input,
    source_event_id: undefined,
    excerpts: [
      ...input.excerpts,
      {
        id: "affects",
        text: JSON.stringify({
          VehicleJourneys: {
            AffectedVehicleJourney: {
              VehicleJourneyRef: "123",
              Route: {
                StopPoints: {
                  AffectedStopPoint: [{ StopPointRef: "station-A" }],
                },
              },
            },
          },
        }),
      },
      {
        id: "validity",
        text: "Start: 2026-10-21T08:00:00Z; End: 2026-10-21T18:00:00Z; Progress: published",
      },
    ],
  };
  assert(stableBundlePayload(siri, siriSource));
  assert.equal(
    stableBundlePayload(
      { ...siri, excerpts: siri.excerpts.filter((e) => e.id !== "validity") },
      siriSource,
    ),
    null,
  );
  assert.notEqual(
    stableBundlePayload(siri, siriSource),
    stableBundlePayload(
      {
        ...siri,
        excerpts: siri.excerpts.map((e) => ({
          ...e,
          text: e.text.replace("station-A", "station-B"),
        })),
      },
      siriSource,
    ),
  );
  assert.equal(
    stableBundlePayload(
      {
        ...siri,
        excerpts: siri.excerpts.map((e) => ({ ...e, id: "renamed-" + e.id })),
      },
      siriSource,
    ),
    stableBundlePayload(siri, siriSource),
  );
});
test("withdrawn AI/storage/access rights and ineligible reports cannot reuse another analysis", () => {
  for (const flag of ["access", "storage", "ai"] as const)
    assert.equal(
      stableBundlePayload(input, {
        ...source,
        rights: { ...source.rights, [flag]: false },
      }),
      null,
    );
  assert.equal(
    stableBundlePayload(
      {
        ...input,
        eligibility: {
          eligible: false,
          reason: "deferred archive",
          policy_version: "v1",
        },
      },
      source,
    ),
    null,
  );
});
test("dated native episode stays stable across cosmetic midnight/alarm-count updates", () => {
  const base = {
    ...input,
    published_at: null,
    source_updated_at: "2026-10-21T23:50:00Z",
    source_metadata: { publisher_generated: true, alarm_count: 3 },
    excerpts: [
      {
        id: "record",
        text: "A public fire dispatch in Lyon was first observed at 2026-10-21T08:00:00Z. The publisher reports a building fire and provides no confirmed outcome.",
      },
    ],
  };
  const a = stableBundlePayload(base, source);
  assert(a);
  assert.equal(
    a,
    stableBundlePayload(
      {
        ...base,
        source_updated_at: "2026-10-22T00:05:00Z",
        source_metadata: { publisher_generated: true, alarm_count: 8 },
      },
      source,
    ),
  );
  assert.notEqual(
    a,
    stableBundlePayload(
      {
        ...base,
        excerpts: [
          {
            id: "record",
            text: base.excerpts[0].text.replace("2026-10-21", "2026-10-22"),
          },
        ],
      },
      source,
    ),
  );
  assert.notEqual(
    a,
    stableBundlePayload(
      {
        ...base,
        excerpts: [
          {
            id: "record",
            text:
              base.excerpts[0].text +
              " Correction: the location is Paris, not Lyon.",
          },
        ],
      },
      source,
    ),
  );
  assert.equal(
    stableBundlePayload(
      {
        ...base,
        excerpts: [
          {
            id: "record",
            text: "A public fire dispatch in Lyon was observed at an unspecified time. The publisher reports a building fire and provides no confirmed outcome.",
          },
        ],
      },
      source,
    ),
    null,
  );
});
test("official expiry and source geography are preserved independently of document formatting", () => {
  const base = {
    ...input,
    official: {
      issuer: "Operator",
      effective_at: "2026-10-21T08:00:00Z",
      expires_at: "2026-10-21T18:00:00Z",
    },
  };
  assert.notEqual(
    stableBundlePayload(base, source),
    stableBundlePayload(
      {
        ...base,
        official: { ...base.official, expires_at: "2026-10-22T18:00:00Z" },
      },
      source,
    ),
  );
  const composed = {
    ...input,
    excerpts: [{ id: "a", text: input.excerpts[0].text + " Café." }],
  };
  assert.equal(
    stableBundlePayload(composed, source),
    stableBundlePayload(
      {
        ...composed,
        excerpts: [
          { id: "b", text: composed.excerpts[0].text.normalize("NFD") },
        ],
      },
      source,
    ),
  );
});
