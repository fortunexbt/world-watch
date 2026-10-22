# PR 1 v2 contracts

This is a proposal. Nothing described here is implemented or verified. It answers the directive in `docs/plans/GLOBAL_OSINT_CORE_PLAN.md` §16 to propose the exact v2 contracts and compatibility mappings before PR 1 (§15) is built.

## Status and basis

- Drafted against commit `889bd29` on `feat/europe-watch` (PR 0 committed).
- All file:line references match that commit.
- No tests were run for this proposal. Statements about behaviour come from reading the code.
- Code identifiers keep the repository's existing spelling (`analyzed_at`, `normalizedText`). Prose uses Canadian spelling.

## Key decisions

1. **Three version axes.** The analysis wire contract stays `ew-1`. Stored records gain a schema version `ew-2`. The taxonomy is versioned separately as `ew-tax-1`. `CONTRACT_VERSION` (contracts.ts:3) is part of job identity (`ingest`, index.ts:453), of the `UNIQUE(report_id,revision,contract_version)` constraint (0001_initial.sql:6), of the exact-content bundle key (`ingest`, index.ts:456) and of the worker spool key (`spoolKey`, src/worker/worker.ts:21-30). `ingest` inserts the job row on every call, including unchanged revisions. Bumping the constant would therefore enqueue a new analysis job for every unchanged revision the collector re-sends. TODO L08 requires re-analysis to be an explicit, audited choice, so PR 1 leaves the wire contract alone.
2. **Decode, don't rewrite.** PR 1 maps ew-1 rows into ew-2 objects at read time with pure functions. No stored row changes and PR 1 ships no migration.
3. **Legacy geography stays legacy.** An ew-1 `location` maps only to a labelled `LegacyPointRadius` display object with `calibrated: false`. It never becomes a v2 geometry assertion, because the stored view does not record whether the point came from the source, the gazetteer, a country centroid or an operator.
4. **Domains by entailment only.** A legacy activity value gets a domain only when the value itself entails one. Everything else maps to domain `unclassified`, and the original ew-1 value is always retained.
5. **One materiality projection.** `alert-material-v2` replaces v1. Both sides of every comparison are recomputed from decoded events with the same projection version, and PR 1 proves that v1 and v2 agree on all ew-1 data.
6. **API stays v1.** The client and API keep returning v1 `IncidentView` objects in PR 1. An ew-1 event serves its stored view verbatim.

## Version axes

| Axis | Constant | Value in PR 1 | Where it appears today | Changes when |
|---|---|---|---|---|
| Analysis wire contract | `CONTRACT_VERSION` (contracts.ts:3) | `ew-1` (unchanged) | `analysis_jobs.contract_version`, `JobInput.contract_version` (contracts.ts:143), `ModelRun.schema_version` as `ew-1/wire-1` (src/worker/adapter.ts:416), targeted review jobs as `ew-1:review:<v>` (index.ts:2072) | An owner-approved prompt/schema change with an explicit re-analysis decision |
| Record schema | `SCHEMA_VERSION` (new) | `ew-2` | Absent from every ew-1 row. ew-1 is inferred from absence | A stored shape changes |
| Taxonomy | `TAXONOMY_VERSION` (new) | `ew-tax-1` | Not present in ew-1 | Types are added, deprecated or redefined |
| Severity rule | `SEVERITY_RULE_VERSION` (new export in severity.ts) | `ew1-grounded-severity-1` | Not recorded today. PR 0 changed the rule | `validateSeverity` semantics change |
| Alert materiality | prefix in `alertMaterialityVersion` | `alert-material-v2` | `alert-material-v1` (alerts.ts:205) | The projected field set changes |

## Temporal semantics

The model distinguishes six kinds of time and never substitutes one for another.

| Time | Meaning | ew-1 source | ew-2 field |
|---|---|---|---|
| Event time | When the occurrence reportedly happened | `Claim.event_start/event_end` (contracts.ts:42-43), `IncidentView.event_start/event_end` (contracts.ts:184-185) | `Claim.event_time`, `Event.times.event` |
| Source time | Publication and update by the publisher | `published_at`, `source_updated_at` (contracts.ts:115-116) | `SourceDocument.times.published_at`, `.source_updated_at` |
| Ingestion time | When this system durably accepted a revision | `observation_revisions.ingested_at`, `observations.first_observed_at` (0001_initial.sql:4-5) | `SourceDocument.times.received_at`, `.first_received_at` |
| Analysis time | When a derivation completed | `analysis_results.analyzed_at`, `IncidentView.analyzed_at` (contracts.ts:188) | `AnalysisRecord.analyzed_at`, `Event.times.analyzed_at`. Never used as event time |
| Knowledge time | When a record version became known to the system | `incident_revisions.known_at` (0001_initial.sql:11) | Envelope `known_at` |
| Validity time | When an instruction or notice applies | `official_instruction.effective_at/expires_at` (contracts.ts:55-56), `official.effective_at/expires_at` (contracts.ts:128-129), `IncidentView.expires_at` (contracts.ts:190) | `Instruction.validity`, `IssuerNotice.validity`, `Event.times.expires_at` |
| Forecast time | Issue time and valid time of a prediction | none | `ForecastTimes` on `Observation` and `Dataset` |

Rules.

- Unknown stays `null`. Nothing defaults to ingestion or analysis time.
- Date-only values keep `precision: "date"` and are never widened to midnight. This matches `canonicalTime` (alerts.ts:90-105) and `temporalStatus` (temporal.ts:3-30).
- Strings that do not parse are kept verbatim as `precision: "unparsed"`. Official `effective_at` reaches `IncidentView.event_start` without `validEventTime` checks (`ingest`, index.ts:534-578), so this case exists.
- Offsets are kept as supplied. No conversion to UTC in stored values.
- ew-1 `temporal_status` was asserted relative to the worker's prompt time `at` (`compactInputs`, src/worker/wire.ts:88-93), which is not stored. It maps to `asserted_phase` with `reference_time: null`.
- Interval ordering (`start <= end`) is enforced on ew-2 writes. ew-1 acceptance never checked it, so decoded ew-1 intervals are kept and flagged `ew1_interval_inverted` instead of rejected.

Proposed additions to `src/shared/temporal.ts`. `validEventTime` moves here unchanged from contracts.ts:235-249 so time parsing has one home.

```ts
import { z } from "zod";

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export function validEventTime(value: string | null): boolean {
  /* body moved verbatim from contracts.ts:235-249 */
}

export const Instant = z
  .string()
  .refine((v) => !DATE_ONLY.test(v) && validEventTime(v), "invalid_instant");

export const TimeValue = z.discriminatedUnion("precision", [
  z.object({ precision: z.literal("instant"), value: Instant }).strict(),
  z
    .object({
      precision: z.literal("date"),
      value: z.string().regex(DATE_ONLY).refine(validEventTime, "invalid_date"),
    })
    .strict(),
  // Retained source text that does not parse. Treated as unknown in computation.
  z.object({ precision: z.literal("unparsed"), raw: z.string() }).strict(),
]);
export type TimeValue = z.infer<typeof TimeValue>;

export const Interval = z
  .object({
    start: TimeValue.nullable(),
    end: TimeValue.nullable(),
    timezone: z.string().nullable(), // IANA zone as stated, never inferred
    uncertainty: z.string().nullable(),
  })
  .strict();
export type Interval = z.infer<typeof Interval>;

export const ForecastTimes = z
  .object({
    model: z.string().min(1),
    run_id: z.string().nullable(),
    issued_at: Instant,
    valid: Interval,
  })
  .strict();

/** Total and lossless. Never reads the clock. */
export function toTimeValue(value: string | null | undefined): TimeValue | null {
  if (value === null || value === undefined) return null;
  if (DATE_ONLY.test(value) && validEventTime(value))
    return { precision: "date", value };
  if (!DATE_ONLY.test(value) && validEventTime(value))
    return { precision: "instant", value };
  return { precision: "unparsed", raw: value };
}
```

## Geometry roles

New module `src/shared/geometry.ts`. The GeoJSON types in `src/shared/geospatial.ts:2-10` move into it, and `geospatial.ts` imports them, so there is one geometry definition.

| Role | Meaning | Example |
|---|---|---|
| `observed_location` | Measured position of a detection or sample | FIRMS pixel centre |
| `observed_footprint` | Measured extent | Copernicus observed flood extent |
| `reported_location` | Position stated by a source, meaning declared by its adapter | A fire-service incident point once TODO G01 defines its meaning |
| `reported_affected_area` | Area a source says is affected | A closure polygon in a notice |
| `inferred_affected_area` | Area derived by a rule or model | Buffer computed by a versioned rule |
| `advisory_area` | Area an issuer's instruction applies to | CAP warning polygon |
| `mapping_aoi` | Area of interest for a mapping activation, not a measured extent | Copernicus EMS AOI |
| `location_uncertainty` | Calibrated uncertainty region with a stated method | Only from a method that documents calibration |
| `candidate_location` | One of several unresolved place candidates | Two cities with the same name |
| `label_position` | Where to draw a label, not where the event is | Country centroid |

Rules.

- Interchange CRS is WGS84 (`EPSG:4326`), `[lon, lat]` order.
- Original geometry and display simplification are stored separately. Intersection always uses the original.
- PR 1 validates structure, coordinate ranges, ring closure, minimum ring length and unsplit antimeridian segments. Self-intersection is not checked in PR 1 and the assertion records `validity_check: "structural"`. A full check belongs with PostGIS `ST_IsValid` in PR 3 or a vetted library chosen then.
- Winding is not enforced on input. RFC 7946 §3.1.6 says parsers should not reject polygons that ignore the right-hand rule. A display copy may be rewound.
- Swapped coordinates cannot be detected in general. Range checks catch `|lat| > 90`. Plausibility against a stated country is a G01 adapter concern, not a schema rule.
- Legacy point+radius is a separate type, never a role. It cannot be placed in `geometry[]`.

```ts
import { z } from "zod";
import { Interval } from "./temporal";

const Lon = z.number().finite().gte(-180).lte(180);
const Lat = z.number().finite().gte(-90).lte(90);
export const Position = z.tuple([Lon, Lat]);
const Line = z.array(Position).min(2);
const Ring = z
  .array(Position)
  .min(4)
  .superRefine((ring, ctx) => {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1])
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ring_not_closed" });
  });

export const Geometry = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("Point"), coordinates: Position }).strict(),
    z.object({ type: z.literal("MultiPoint"), coordinates: z.array(Position).min(1) }).strict(),
    z.object({ type: z.literal("LineString"), coordinates: Line }).strict(),
    z.object({ type: z.literal("MultiLineString"), coordinates: z.array(Line).min(1) }).strict(),
    z.object({ type: z.literal("Polygon"), coordinates: z.array(Ring).min(1) }).strict(),
    z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(Ring).min(1)).min(1) }).strict(),
  ])
  .superRefine((g, ctx) => {
    // RFC 7946 §3.1.9: crossing geometries are cut into Multi* parts.
    const lines =
      g.type === "LineString" ? [g.coordinates]
      : g.type === "MultiLineString" || g.type === "Polygon" ? g.coordinates
      : g.type === "MultiPolygon" ? g.coordinates.flat()
      : [];
    for (const line of lines)
      for (let i = 1; i < line.length; i++)
        if (Math.abs(line[i][0] - line[i - 1][0]) > 180)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "antimeridian_unsplit" });
  });
export type Geometry = z.infer<typeof Geometry>;

export const GeometryRole = z.enum([
  "observed_location",
  "observed_footprint",
  "reported_location",
  "reported_affected_area",
  "inferred_affected_area",
  "advisory_area",
  "mapping_aoi",
  "location_uncertainty",
  "candidate_location",
  "label_position",
]);

export const GeometryAssertion = z
  .object({
    id: z.string().min(1),
    role: GeometryRole,
    geometry: Geometry,
    display_geometry: Geometry.nullable(),
    crs: z.literal("EPSG:4326"),
    validity_check: z.enum(["structural", "full"]),
    basis: z
      .object({
        kind: z.enum(["source_supplied", "gazetteer", "operator", "rule", "model_place"]),
        ref: z.string().nullable(), // adapter id, gazetteer feature id or rule id
        version: z.string().nullable(),
      })
      .strict(),
    place: z.object({ name: z.string(), country: z.string().nullable() }).strict().nullable(),
    evidence_ids: z.array(z.string()),
    valid: Interval,
  })
  .strict();

/**
 * ew-1 display convention from IncidentView.location (contracts.ts:176-183)
 * and ObservationInput.source_geo (contracts.ts:119-125). Radii are generic
 * defaults (geo.ts:43-52, 100-108, 122-129) and are never uncertainty.
 */
export const LegacyPointRadius = z
  .object({
    convention: z.literal("ew1_point_radius"),
    calibrated: z.literal(false),
    name: z.string(),
    country: z.string().nullable(),
    lon: Lon,
    lat: Lat,
    accuracy: z.enum(["point", "city", "country", "area"]),
    radius_km: z.number().finite().nonnegative().nullable(), // null only for source_geo without radius
  })
  .strict();
```

## Record primitives

All primitives live in a new `src/shared/records.ts`. Every record carries the shared envelope. Field names carried over from ew-1 keep their ew-1 names.

### Shared envelope

```ts
import { z } from "zod";
import { Activity, Evidence } from "./contracts";
import { Instant, Interval, TimeValue, ForecastTimes } from "./temporal";
import { GeometryAssertion, LegacyPointRadius, Position } from "./geometry";
import { Severity, TaxonomyRef } from "./taxonomy";

export const SCHEMA_VERSION = "ew-2";
const RecordId = z.string().min(1).max(512);

export const RecordType = z.enum([
  "source_document", "observation", "claim", "event", "entity",
  "track", "track_sample", "dataset", "relationship", "analysis",
]);

/** Points at the unchanged ew-1 row a record was decoded from. */
export const LegacyRef = z
  .object({
    contract: z.literal("ew-1"),
    table: z.enum([
      "observation_revisions", "analysis_results", "claims",
      "incidents", "incident_revisions", "evidence_links", "outbox",
    ]),
    key: z.array(z.union([z.string(), z.number()])), // primary-key values in column order
  })
  .strict();

const envelope = <T extends z.infer<typeof RecordType>>(type: T) => ({
  id: RecordId,
  schema_version: z.literal(SCHEMA_VERSION),
  record_type: z.literal(type),
  known_at: Instant,
  quality_flags: z.array(z.string()),
  legacy: LegacyRef.nullable(),
});

export const Provenance = z
  .object({
    source_id: z.string(),
    source_native_id: z.string(),
    source_revision: z.string(),
    canonical_url: z.string().nullable(), // tombstoned observations store '' (index.ts:330)
    upstream_origin_ids: z.array(RecordId),
    parser_version: z.string().nullable(),
    rights_policy_version: z.string().nullable(),
  })
  .strict();

export const DocumentRef = z
  .object({ document_id: RecordId, revision: z.string().nullable() })
  .strict();

export const RecordRef = z
  .object({
    record_type: RecordType,
    id: RecordId,
    version: z.union([z.number().int().positive(), z.string()]).nullable(),
  })
  .strict();
```

### Source document

One record per document revision. `document_id` is `observations.id` and `revision` is the existing content revision.

```ts
export const EvidenceSpan = Evidence.extend({
  char_start: z.number().int().nonnegative().nullable(),
  char_end: z.number().int().nonnegative().nullable(),
});

export const IssuerNotice = z
  .object({
    issuer: z.string(),
    message_type: z.string().nullable(),
    references: z.array(z.string()).nullable(),
    cancelled: z.boolean().nullable(), // absent in ew-1 input stays null
    validity: Interval,
  })
  .strict();

export const SourceDocument = z
  .object({
    ...envelope("source_document"),
    document_id: RecordId,
    revision: z.string(),
    provenance: Provenance,
    title: z.string(),
    original_language: z.string(),
    input_coverage: z.enum(["full_licensed_text", "permitted_excerpt", "title_only"]),
    times: z
      .object({
        published_at: TimeValue.nullable(),
        source_updated_at: TimeValue.nullable(),
        first_received_at: Instant,
        received_at: Instant,
      })
      .strict(),
    spans: z.array(EvidenceSpan),
    content_hash: z
      .object({
        algorithm: z.literal("sha256"),
        scope: z.enum(["ew1_revision_fields", "retained_bytes"]),
        value: z.string(),
      })
      .strict()
      .nullable(),
    reported_geometry: z.array(GeometryAssertion),
    legacy_display: LegacyPointRadius.nullable(),
    issuer_notice: IssuerNotice.nullable(),
    source_event_id: z.string().nullable(),
    source_reports: z.array(
      z.object({ native_id: z.string(), canonical_url: z.string(), published_at: TimeValue.nullable() }).strict(),
    ),
    publisher_generated: z.boolean().nullable(),
    alarm_count: z.number().int().nonnegative().nullable(),
    admission: z
      .object({ eligible: z.boolean(), reason: z.string(), policy_version: z.string() })
      .strict()
      .nullable(),
    priority: z.number().int().nullable(),
  })
  .strict();
```

### Observation record

No ew-1 table stores observations. FIRMS and Copernicus features (`GeoFeature`, geospatial.ts:11-28) are computed per request (`/api/geospatial`, index.ts:1611) and map to this type when PR 4 globalises that path.

```ts
export const Measurement = z
  .object({
    quantity: z.string(),
    value: z.number().nullable(),
    unit: z.string().nullable(), // normalised unit
    native: z.object({ value: z.union([z.string(), z.number()]), unit: z.string().nullable() }).strict(),
    conversion: z.string().nullable(), // rule id when value differs from native
  })
  .strict();

export const Observation = z
  .object({
    ...envelope("observation"),
    provenance: Provenance,
    kind: z.enum(["direct_measurement", "source_derived", "prediction"]),
    method: z
      .object({
        sensor: z.string().nullable(),
        platform: z.string().nullable(),
        algorithm: z.string().nullable(),
        processing_version: z.string().nullable(),
      })
      .strict(),
    observed: Interval,
    received_at: Instant,
    forecast: ForecastTimes.nullable(),
    measurements: z.array(Measurement),
    geometry: z.array(GeometryAssertion),
    quality: z
      .object({ flags: z.array(z.string()), native_confidence: z.string().nullable() })
      .strict(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if ((o.kind === "prediction") !== (o.forecast !== null))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "forecast_times_iff_prediction" });
  });
```

### Claim record

An attributed proposition. ew-1 claims only express occurrences. The `attribute` form covers counts and claimed responsibility, so a casualty estimate and a minimum confirmed count stay distinct.

```ts
export const Proposition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("occurrence"), taxonomy: TaxonomyRef }).strict(),
  z
    .object({
      kind: z.literal("attribute"),
      subject: RecordRef,
      attribute: z.string(), // registered attribute id, e.g. "fatalities", "claimed_responsibility"
      value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
      qualifier: z.enum(["exact", "estimate", "minimum_confirmed", "claimed_by_party"]).nullable(),
    })
    .strict(),
]);

export const PlaceReference = z
  .object({
    name: z.string(),
    country: z.string().nullable(),
    admin: z.string().nullable(),
    role: z.enum(["occurrence", "affected", "origin", "mentioned"]),
    evidence_ids: z.array(z.string()),
    uncertainty: z.string().nullable(),
    resolution: z
      .object({
        status: z.enum(["resolved", "ambiguous", "unresolved", "not_recorded"]),
        resolver_version: z.string().nullable(),
        candidates: z.array(z.object({ gazetteer: z.string(), feature_id: z.string() }).strict()),
      })
      .strict(),
  })
  .strict();

export const Instruction = z
  .object({ issuer: z.string(), text: z.string(), validity: Interval, evidence_ids: z.array(z.string()) })
  .strict();

export const Claim = z
  .object({
    ...envelope("claim"),
    analysis_id: RecordId.nullable(),
    local_id: z.string().nullable(), // model-local claim id
    documents: z.array(DocumentRef),
    attribution: z
      .object({
        source_id: z.string(),
        issuer: z.string().nullable(),
        publisher_generated: z.boolean().nullable(),
      })
      .strict(),
    proposition: Proposition,
    summary: z.string(),
    polarity: z.enum(["affirmed", "negated"]),
    modality: z.enum(["actual", "planned", "hypothetical", "unknown"]),
    event_time: Interval,
    asserted_phase: z
      .object({
        value: z.enum(["planned", "current", "historical", "unknown"]),
        reference_time: Instant.nullable(),
      })
      .strict()
      .nullable(),
    places: z.array(PlaceReference),
    severity: Severity, // defined under Taxonomy design
    instruction: Instruction.nullable(),
    mentions: z
      .object({ violence: z.enum(["mentioned", "not_mentioned", "unclear"]).nullable() })
      .strict(),
    evidence_ids: z.array(z.string()).min(1),
    review_requested: z.boolean(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!c.documents.length && c.legacy === null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "claim_requires_document" });
  });
```

### Event record

A versioned assessment. `id` and `version` are the existing incident identity and integer version. A version embeds the claim snapshots it was assessed with, because operator corrections edit claims inside the view (`/api/corrections`, index.ts:2712-2716) and those edits exist nowhere else.

```ts
export const EvidenceState = z.enum([
  "reported", "corroborated", "contested", "retracted", "superseded", "unknown",
]);

export const Event = z
  .object({
    ...envelope("event"),
    version: z.number().int().positive(),
    revision_reason: z.string(),
    taxonomy: TaxonomyRef,
    text: z
      .object({ headline: z.string(), summary_en: z.string(), summary_it: z.string().nullable() })
      .strict(),
    severity: Severity,
    evidence_state: EvidenceState,
    source_authority: z.enum(["official_issuer", "none_asserted"]),
    corrected: z.boolean(),
    cancelled: z.boolean(),
    merged_into: RecordId.nullable(),
    assessment: z.enum(["analysed", "source_only", "pending_analysis"]),
    review_needed: z.boolean(),
    times: z
      .object({
        event: Interval,
        expires_at: TimeValue.nullable(),
        published_at: TimeValue.nullable(),
        ingested_at: Instant, // ingestion of the revision that produced this version
        analyzed_at: Instant.nullable(),
        updated_at: Instant,
      })
      .strict(),
    geometry: z.array(GeometryAssertion),
    legacy_display: LegacyPointRadius.nullable(),
    claims: z.array(Claim), // ordered as in the version
    documents: z.array(z.object({ ref: DocumentRef, retracted: z.boolean() }).strict()),
    derivation: z.object({ rule: z.string(), version: z.string() }).strict(),
  })
  .strict();

export const Tombstone = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    record_type: z.literal("tombstone"),
    target: z
      .object({
        record_type: z.enum(["event", "source_document"]),
        id: RecordId,
        last_version: z.union([z.number().int().positive(), z.string()]).nullable(),
      })
      .strict(),
    deleted_at: Instant,
    reason: z.enum(["retention_expired", "source_deleted"]).nullable(), // ew-1 does not record it
    legacy: LegacyRef.nullable(),
  })
  .strict();
```

### Entity record

No ew-1 counterpart. Gazetteer cities (`src/shared/gazetteer.json`, read in geo.ts:2-13) are reference data, referenced from `PlaceReference.resolution.candidates`, and do not become entity rows in PR 1.

```ts
const AssertionBasis = z
  .object({
    kind: z.enum(["source", "operator", "rule", "model"]),
    id: z.string(),
    version: z.string().nullable(),
  })
  .strict();

export const IdentifierScheme = z.enum([
  "mmsi", "imo", "icao24", "callsign", "registration",
  "wikidata", "geonames", "ew_gazetteer", "source_native",
]);

export const Entity = z
  .object({
    ...envelope("entity"),
    entity_type: z.enum(["vessel", "aircraft", "organisation", "infrastructure", "place", "other"]),
    names: z.array(
      z.object({
        value: z.string(),
        language: z.string().nullable(),
        valid: Interval,
        basis: AssertionBasis,
        evidence_ids: z.array(z.string()),
      }).strict(),
    ),
    identifiers: z.array(
      z.object({
        scheme: IdentifierScheme,
        value: z.string(),
        valid: Interval,
        basis: AssertionBasis,
        evidence_ids: z.array(z.string()),
      }).strict(),
    ),
  })
  .strict();
```

### Track records

Samples are separate records so a track never holds an unbounded array. No ew-1 counterpart.

```ts
export const Track = z
  .object({
    ...envelope("track"),
    entity_id: RecordId,
    identity: z.object({ scheme: IdentifierScheme, value: z.string() }).strict(),
    segments: z.array(
      z.object({
        segment_id: RecordId,
        gap_rule: z.string(), // rule id that started this segment
        start: Instant,
        end: Instant.nullable(),
        sample_count: z.number().int().nonnegative(),
      }).strict(),
    ),
  })
  .strict();

export const TrackSample = z
  .object({
    ...envelope("track_sample"),
    track_id: RecordId,
    segment_id: RecordId,
    provenance: Provenance,
    observed_at: Instant,
    received_at: Instant,
    position: z.object({ type: z.literal("Point"), coordinates: Position }).strict(),
    altitude: z
      .object({ value_m: z.number(), reference: z.enum(["barometric", "geometric", "unknown"]) })
      .strict()
      .nullable(),
    speed_mps: z.number().nonnegative().nullable(),
    course_deg: z.number().gte(0).lt(360).nullable(),
    status: z.enum(["received", "interpolated", "predicted"]),
  })
  .strict();
```

### Dataset record

Catalogue entry for a layer. Large arrays and imagery stay outside the transactional database and are referenced through `assets`.

```ts
export const Dataset = z
  .object({
    ...envelope("dataset"),
    provenance: Provenance,
    kind: z.enum([
      "forecast_field", "satellite_scene", "boundary_collection",
      "terrain", "imagery_derived", "context_features",
    ]),
    title: z.string(),
    footprint: GeometryAssertion.nullable(),
    times: z
      .object({
        acquired: Interval.nullable(),
        forecast: ForecastTimes.nullable(),
        published_at: TimeValue.nullable(),
      })
      .strict(),
    resolution: z.object({ value: z.number().positive(), unit: z.string() }).strict().nullable(),
    licence: z
      .object({ id: z.string().nullable(), url: z.string().nullable(), attribution: z.string() })
      .strict(),
    assets: z.array(
      z.object({
        href: z.string(),
        media_type: z.string(),
        checksum: z.string().nullable(),
        bytes: z.number().int().nonnegative().nullable(),
      }).strict(),
    ),
    truncated: z.boolean(), // disclosed truncation, e.g. the capped FIRMS parse
    stac_id: z.string().nullable(),
  })
  .strict();
```

### Typed relationships

```ts
export const RelationshipType = z.enum([
  "supports", "contradicts", "corrects", "retracts", "supersedes",
  "derived_from", "same_origin", "affects",
  "possible_same_event", "merged_into", "split_from",
]);
const RECORD_TARGET_ONLY = new Set([
  "supersedes", "derived_from", "same_origin", "affects",
  "possible_same_event", "merged_into", "split_from",
]);

export const Relationship = z
  .object({
    ...envelope("relationship"),
    type: RelationshipType,
    from: RecordRef,
    to: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("record"), ref: RecordRef }).strict(),
      z.object({ kind: z.literal("text"), text: z.string() }).strict(), // unresolved ew-1 targets
    ]),
    basis: z
      .object({
        kind: z.enum(["model", "rule", "operator", "source", "legacy_ew1"]),
        id: z.string(),
        version: z.string().nullable(),
      })
      .strict(),
    evidence_ids: z.array(z.string()),
    reason: z.string().nullable(),
    valid: z.object({ from: Instant, to: Instant.nullable() }).strict(), // knowledge-time validity
  })
  .strict()
  .superRefine((r, ctx) => {
    // ew-1 model targets are free text. Only decoded legacy edges may keep them.
    if (r.to.kind === "text" && RECORD_TARGET_ONLY.has(r.type) && r.basis.kind !== "legacy_ew1")
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "relationship_requires_record_target" });
  });
```

`located_at` from the plan's list is deferred until a producer exists (entities in PR 7). A relationship decoded from ew-1 gets a deterministic id, `sha256("rel:" + type + ":" + from + ":" + to + ":" + basis)`, so repeated decoding yields the same id.

### Analysis record

Not a world primitive. It holds the derivation that produced claims, so every claim points to a derivation version.

```ts
export const AnalysisRecord = z
  .object({
    ...envelope("analysis"),
    job_id: RecordId,
    document: DocumentRef,
    contract_version: z.string(), // analysis_jobs.contract_version, e.g. "ew-1" or "ew-1:review:<v>"
    analyzed_at: Instant,
    run: z
      .object({
        invocation_id: z.string().optional(),
        requested_model: z.string(),
        requested_tier: z.string(),
        actual_model: z.string().nullable(), // unknown stays null (TODO W03)
        actual_tier: z.string().nullable(),
        client_version: z.string(),
        prompt_version: z.string(),
        schema_version: z.string(),
        duration_ms: z.number(),
        usage: z.unknown(),
        tool_attempts: z.number().int(),
      })
      .strict(),
    reported_language: z.string(), // model-reported, distinct from the source-declared language
    relevance: z.object({ relevant: z.boolean(), reason: z.string() }).strict(),
    summary: z.object({ en: z.string(), it: z.string().nullable() }).strict(),
    uncertainty_flags: z.array(z.string()),
    targeted_review: z.boolean(),
    claim_ids: z.array(RecordId),
    candidate_event_texts: z.array(z.string()), // unverified model output
    severity_rule: z.string().nullable(), // null for every ew-1 result
  })
  .strict();
```

## Taxonomy design

New module `src/shared/taxonomy.ts`. Source inventory categories (`SourceRecord.categories`, contracts.ts:211, used in src/collector/registry.ts) are a separate registry and are not mapped.

```ts
import { z } from "zod";
import { Activity } from "./contracts";

export const TAXONOMY_VERSION = "ew-tax-1";

export const Domain = z.enum([
  "public_activity", "conflict", "aviation", "maritime", "weather", "hazards",
  "infrastructure", "cyber", "governance", "health", "economy", "environment",
  "unclassified", // no domain assessment exists
]);
type Domain = z.infer<typeof Domain>;

export type TaxonomyType = {
  id: string; // stable, never reused
  domains: readonly Domain[];
  label: string;
  definition: string;
  examples: readonly string[];
  exclusions: readonly string[];
  aliases: readonly string[];
  introduced_in: string;
  deprecated_in: string | null;
  replaced_by: string | null;
};

export const TAXONOMY_TYPES = {
  demonstration: { id: "demonstration", domains: ["public_activity"], /* … */ },
  strike: { id: "strike", domains: ["public_activity"], /* … */ },
  gathering: { id: "gathering", domains: ["public_activity"], /* … */ },
  disruption: { id: "disruption", domains: ["unclassified"], /* … */ },
  confrontation: { id: "confrontation", domains: ["unclassified"], /* … */ },
  violence: { id: "violence", domains: ["unclassified"], /* … */ },
  fire_or_property_damage: { id: "fire_or_property_damage", domains: ["unclassified"], /* … */ },
  displacement: { id: "displacement", domains: ["unclassified"], /* … */ },
  advisory: { id: "advisory", domains: ["unclassified"], /* … */ },
  earthquake: { id: "earthquake", domains: ["hazards"], /* … */ },
  tropical_cyclone: { id: "tropical_cyclone", domains: ["hazards"], /* … */ },
  flood: { id: "flood", domains: ["hazards"], /* … */ },
  wildfire: { id: "wildfire", domains: ["hazards"], /* … */ },
  volcanic_eruption: { id: "volcanic_eruption", domains: ["hazards"], /* … */ },
  drought: { id: "drought", domains: ["hazards"], /* … */ },
  unknown: { id: "unknown", domains: ["unclassified"], /* … */ },
} as const satisfies Record<string, TaxonomyType>;

export const ACTOR_ROLES = [] as const; // ew-tax-1 registers none

export const TaxonomyRef = z
  .object({
    taxonomy_version: z.literal(TAXONOMY_VERSION),
    domain: Domain,
    type: z.string(),
    subtype: z.string().nullable(),
    actor_roles: z.array(z.string()),
    tags: z.array(z.string()),
    legacy: z.object({ scheme: z.literal("ew-1-activity"), value: Activity }).strict().nullable(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const entry = TAXONOMY_TYPES[t.type as keyof typeof TAXONOMY_TYPES];
    if (!entry || !(entry.domains as readonly string[]).includes(t.domain))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unregistered_taxonomy_type" });
    if (t.subtype !== null || t.actor_roles.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unregistered_taxonomy_detail" });
  });
```

`unclassified` means no domain assessment exists. Type `unknown` means a classifier ran and could not determine the type. ew-1 never assessed domains, so only values whose meaning entails a domain receive one. Adapters must not infer a domain from keywords in a source name.

### Activity mapping

Every value of `Activity` (contracts.ts:12-24) maps through one table, typed with `satisfies Record<z.infer<typeof Activity>, …>` so a new ew-1 value fails compilation.

The six hazard values were added to ew-1 after `889bd29`, in the worldwide pass (`70da0d9`), and are already shipped. Only the structured USGS (`src/collector/adapters/usgs.ts`) and GDACS (`src/collector/adapters/gdacs.ts`) adapters emit them, from the issuer's own event type. The analyst prompt does not offer them. They need no wire contract change, because they are existing ew-1 values.

| ew-1 `Activity` | Domain | Type | Claim modality | Reason |
|---|---|---|---|---|
| `planned_demonstration` | `public_activity` | `demonstration` | `planned` | Phase moves out of the type into modality |
| `ongoing_demonstration` | `public_activity` | `demonstration` | `actual` | Same |
| `strike` | `public_activity` | `strike` | from `temporal_status` | Collective labour action. Economy domain not inferred |
| `gathering` | `public_activity` | `gathering` | from `temporal_status` | Entails collective public activity |
| `disruption` | `unclassified` | `disruption` | from `temporal_status` | ew-1 used it for transport, access and service disruption with no recorded cause |
| `confrontation` | `unclassified` | `confrontation` | from `temporal_status` | Not in the analyst prompt's scope list (src/worker/analyst.ts:2). Context not recorded |
| `reported_violence` | `unclassified` | `violence` | from `temporal_status` | "reported" is an evidence state, not a type. Violence does not entail public order or conflict |
| `property_damage_fire` | `unclassified` | `fire_or_property_damage` | from `temporal_status` | The prompt uses it for fire reports and forbids inferring damage (analyst.ts:2). The compound value cannot be split after the fact |
| `displacement` | `unclassified` | `displacement` | from `temporal_status` | See open question 2 |
| `official_advisory` | `unclassified` | `advisory` | from `temporal_status` | Issuer authority is carried by `source_authority`, not the type |
| `earthquake` | `hazards` | `earthquake` | from `temporal_status` | The value names a natural hazard, so the domain is entailed. Set from the USGS feed or GDACS type `EQ` |
| `tropical_cyclone` | `hazards` | `tropical_cyclone` | from `temporal_status` | Same, GDACS type `TC`. Weather domain not inferred |
| `flood` | `hazards` | `flood` | from `temporal_status` | Same, GDACS type `FL` |
| `wildfire` | `hazards` | `wildfire` | from `temporal_status` | Same, GDACS type `WF`. Kept apart from `fire_or_property_damage`, which the model assigns to fire reports of any kind |
| `volcanic_eruption` | `hazards` | `volcanic_eruption` | from `temporal_status` | Same, GDACS type `VO` |
| `drought` | `hazards` | `drought` | from `temporal_status` | Same, GDACS type `DR`. Environment domain not inferred |
| `other_unknown` | `unclassified` | `unknown` | from `temporal_status` | Classifier output was unknown |

Modality from `temporal_status` is `planned` for `planned`, `actual` for `current` or `historical`, and `unknown` for `unknown`. An activity-implied modality takes precedence, because "a demonstration was planned" stays true after its date passes. `TaxonomyRef.legacy` always keeps the original value, so the mapping is injective even where two values share a type.

### Impact mapping

`Impact` (contracts.ts:4-11) is the ew-1 model's ordinal under the analyst rubric (analyst.ts:4). It maps into the `direct_impact` dimension under rule `ew1-impact-direct-1`. All other dimensions stay `null` because ew-1 never assessed them.

| ew-1 `Impact` | `native.value` | `dimensions.direct_impact` |
|---|---|---|
| `informational` | `informational` | `none_stated` (rubric says "explicitly no disruption") |
| `minor` | `minor` | `minor` |
| `significant` | `significant` | `significant` |
| `severe` | `severe` | `severe` |
| `critical` | `critical` | `critical` |
| `unknown` | `unknown` | `null` |

`Claim.impacts` (contracts.ts:47) becomes `severity.evidence_phrases` in order. `impact_uncertainty` (contracts.ts:50) becomes `severity.uncertainty`. Operator corrections write the correction reason into that field (`/api/corrections`, index.ts:2712-2716), which the decoder cannot distinguish from model text.

```ts
export const SeverityLevel = z.enum(["none_stated", "minor", "significant", "severe", "critical"]);

export const Severity = z
  .object({
    native: z
      .object({
        scale: z.string(), // "ew-1-impact" for every ew-1 value
        value: z.union([z.string(), z.number()]).nullable(),
        unit: z.string().nullable(),
      })
      .strict(),
    dimensions: z
      .object({
        rule: z.string(),
        urgency: SeverityLevel.nullable(),
        affected_area: SeverityLevel.nullable(),
        persistence: SeverityLevel.nullable(),
        direct_impact: SeverityLevel.nullable(),
        exposure: SeverityLevel.nullable(),
        operational_relevance: SeverityLevel.nullable(),
      })
      .strict(),
    evidence_phrases: z.array(z.string()),
    uncertainty: z.string().nullable(),
    validation: z.object({ validator: z.string(), version: z.string().nullable() }).strict().nullable(),
  })
  .strict();
```

### Severity validators

Validators are keyed by native scale. PR 1 registers exactly one, which wraps PR 0's `validateSeverity` (severity.ts:144-170) without changing its logic. `validateResult` (contracts.ts:285) calls `validateScaledSeverity` instead of `validateSeverity`, so there is one route. A later scale, such as earthquake magnitude in PR 4, adds a member to `SeverityContext` and registers its own validator. Such a validator may check units and magnitude type and must never translate magnitude into casualties.

The registry lives in `src/shared/severity.ts`, which imports only types from contracts.ts. Putting it in taxonomy.ts would create a value-import cycle (contracts.ts to taxonomy.ts to contracts.ts for `Activity`) that fails at module evaluation.

```ts
// additions to src/shared/severity.ts
import type { EventClaim, JobInput } from "./contracts.js";

export const SEVERITY_RULE_VERSION = "ew1-grounded-severity-1";

/** One member per registered native scale. */
export type SeverityContext = { scale: "ew-1-impact"; claim: EventClaim; input: JobInput };

type SeverityValidator<C extends SeverityContext> = {
  id: string;
  version: string;
  /** Throws a stable error code. Never coerces. */
  validate(context: C): void;
};

export const SEVERITY_VALIDATORS = {
  "ew-1-impact": {
    id: "ew1-grounded-severity",
    version: SEVERITY_RULE_VERSION,
    validate: (context) => validateSeverity(context.claim, context.input),
  },
} satisfies {
  [S in SeverityContext["scale"]]: SeverityValidator<Extract<SeverityContext, { scale: S }>>;
};

export function validateScaledSeverity(context: SeverityContext): void {
  const validator = SEVERITY_VALIDATORS[context.scale];
  if (!validator) throw Error("unregistered_severity_scale");
  validator.validate(context);
}
```

Decoding never runs validators. A historical ew-1 claim was accepted under whatever rule applied at the time, including the pre-PR 0 `violence_mentioned` rule, so decoded claims record `validation: { validator: "ew1-host-validation", version: null }` instead of claiming they passed today's rule.

## Compatibility mapping

Every ew-1 field below has a destination or an explicit reason it has none. "Verbatim" means the string or number is copied unchanged.

### EventClaim fields

Source is `Claim` (contracts.ts:35-78) as stored inside incident views, augmented in `complete` (index.ts:1088-1099).

| ew-1 field | Cited at | ew-2 location | Rule |
|---|---|---|---|
| view claim `id` (`${analysis_id}:${local}`) | index.ts:1094 | `Claim.id` | Verbatim. Equals `claims.id` (index.ts:1145) |
| `model_claim_id` | contracts.ts:194, index.ts:1095 | `Claim.local_id` | Verbatim. Must equal the suffix of `id`, otherwise `row_view_identity_mismatch` |
| model `id` | contracts.ts:37 | `Claim.local_id` | Used when `model_claim_id` is absent |
| analysis id prefix | index.ts:960 | `Claim.analysis_id` | Split from `id` at the first `:` after the 64-character hash |
| `report_id`, `content_revision` | contracts.ts:192-193, index.ts:1096-1097 | `Claim.documents[0]` | Absent gives `documents: []` and flag `ew1_claim_document_unrecorded` |
| `activity` | contracts.ts:38 | `proposition.taxonomy` and `.legacy` | Activity mapping table |
| `summary` | contracts.ts:39 | `Claim.summary` | Verbatim |
| `evidence_ids` | contracts.ts:40 | `Claim.evidence_ids` | Verbatim, scoped by `documents` |
| `places[].name/country/admin/evidence_ids/uncertainty` | contracts.ts:26-34, 41 | `Claim.places[]` | Verbatim, `role: "occurrence"`, `resolution.status: "not_recorded"` |
| `event_start`, `event_end` | contracts.ts:42-43 | `event_time.start/end` | `toTimeValue` |
| `timezone` | contracts.ts:44 | `event_time.timezone` | Verbatim |
| `temporal_status` | contracts.ts:45 | `asserted_phase.value`, `modality` | `reference_time: null` |
| `time_uncertainty` | contracts.ts:46 | `event_time.uncertainty` | Verbatim |
| `impacts` | contracts.ts:47 | `severity.evidence_phrases` | Verbatim, order kept |
| `violence_mentioned` | contracts.ts:48 | `mentions.violence` | `yes` to `mentioned`, `no` to `not_mentioned`, `unclear` to `unclear`. The prompt says "no" means not mentioned, not peaceful (analyst.ts:3) |
| `impact` | contracts.ts:49 | `severity.native`, `severity.dimensions` | Impact mapping table |
| `impact_uncertainty` | contracts.ts:50 | `severity.uncertainty` | Verbatim |
| `official_instruction` | contracts.ts:51-60 | `Claim.instruction` | `instruction` to `text`, `effective_at`/`expires_at` to `validity` |
| `relationships[]` | contracts.ts:61-76 | `Relationship` records, `from` this claim, `to.kind: "text"`, `basis: legacy_ew1` with the run's prompt version | `supports`, `contradicts`, `corrects`, `retracts` keep their names. `possible_duplicate` becomes `possible_same_event`. `origin` becomes `derived_from` (open question 3) |
| none | | `polarity` | Always `affirmed`. The prompt records only affirmative claims and places (analyst.ts:7) |
| none | | `attribution` | `source_id` and `publisher_generated` from the document. `issuer` from `instruction.issuer` when present |

Model relationship targets are free text by design ("textual target if no ID", analyst.ts:7). The record-only types (`possible_same_event` and `derived_from` among them) accept a text target only when `basis.kind` is `legacy_ew1`, which the `Relationship` refinement allows. That exemption is the single place where legacy data relaxes a v2 rule.

Each claim embedded in an event version gets envelope `known_at` equal to that version's `known_at` and `legacy` pointing at the version row (`incidents` or `incident_revisions`, key `[id, version]`).

### Analysis and job input

| ew-1 field | Cited at | ew-2 location | Rule |
|---|---|---|---|
| `analysis_results.id` | 0001_initial.sql:8, index.ts:960 | `AnalysisRecord.id` | Verbatim (`sha256("analysis:" + job_id)`) |
| `analysis_results.job_id` | 0001_initial.sql:8 | `job_id` | Verbatim |
| `analysis_results.report_id/revision` | 0001_initial.sql:8 | `document` | Verbatim |
| `analysis_results.analyzed_at` | 0001_initial.sql:8 | `analyzed_at`, envelope `known_at` | Verbatim |
| `analysis_jobs.contract_version` | 0001_initial.sql:6 | `contract_version` | Verbatim, including `ew-1:review:<v>` |
| `Analysis.report_id/content_revision/input_coverage` | contracts.ts:81-87 | not duplicated | Equal to the job input by acceptance check (contracts.ts:252-257) |
| `Analysis.original_language` | contracts.ts:88 | `reported_language` | Model output. The source-declared language stays on `SourceDocument` |
| `Analysis.relevant/relevance_reason` | contracts.ts:89-90 | `relevance` | Verbatim |
| `Analysis.summary_en/summary_it` | contracts.ts:91-92 | `summary` | Verbatim |
| `Analysis.published_at/source_updated_at` | contracts.ts:93-94 | not duplicated | Equal to the input by acceptance check (contracts.ts:258-262) |
| `Analysis.claims` | contracts.ts:95 | `claim_ids` | Ids formed as in `complete` (index.ts:1094) |
| `Analysis.candidate_incident_ids` | contracts.ts:96 | `candidate_event_texts` | Unverified model output, kept as text |
| `Analysis.uncertainty_flags` | contracts.ts:97 | `uncertainty_flags` | Verbatim |
| `Analysis.targeted_review` | contracts.ts:98 | `targeted_review` | Verbatim |
| `Batch.contract_version` | contracts.ts:103 | not stored | The envelope is not persisted. Version comes from the job row |
| `ModelRun.*` | contracts.ts:154-166 | `run` | Verbatim. Null actual model and tier stay null |
| none | | `severity_rule` | `null` for ew-1 (open question 6) |
| `ObservationInput.source_id/native_id/canonical_url` | contracts.ts:110-112 | `SourceDocument.provenance` | Verbatim |
| `title`, `original_language`, `input_coverage` | contracts.ts:113-117 | same names | Verbatim |
| `published_at`, `source_updated_at` | contracts.ts:115-116 | `times.*` | `toTimeValue`. Unparseable strings are kept as `unparsed` |
| `excerpts[]` | contracts.ts:118 | `spans[]` | `id` and `text` verbatim, offsets `null` |
| `source_geo` | contracts.ts:119-125 | `legacy_display` | Verbatim, `radius_km: null` when absent. `reported_geometry: []` until TODO G01 defines adapter meaning |
| `official` | contracts.ts:126-133 | `issuer_notice` | Absent `cancelled` and `references` stay `null` |
| `source_event_id` | contracts.ts:134 | `source_event_id` | Verbatim |
| `source_metadata` | contracts.ts:135 | `publisher_generated`, `alarm_count` | Verbatim |
| `source_reports` | contracts.ts:136 | `source_reports` | `published_at` through `toTimeValue` |
| `eligibility` | contracts.ts:137 | `admission` | Verbatim |
| `priority` | contracts.ts:138 | `priority` | Verbatim |
| `JobInput.report_id` | contracts.ts:141 | `document_id`, envelope `id` is `${report_id}:${revision}` | Verbatim |
| `JobInput.content_revision` | contracts.ts:142 | `revision`, `content_hash` | `scope: "ew1_revision_fields"`. It hashes title, excerpts, geo, official and published (`ingest`, index.ts:387-395), not retained bytes |
| `JobInput.contract_version` | contracts.ts:143 | not on the document | Job concern, kept in `analysis_jobs` |
| `JobInput.first_observed_at` | contracts.ts:144 | `times.first_received_at` | Verbatim |
| `JobInput.ingested_at` | contracts.ts:145 | `times.received_at`, envelope `known_at` | Verbatim. Equal to `observation_revisions.ingested_at` |

### IncidentView fields

Source is `IncidentView` (contracts.ts:167-202) as stored in `incidents.view` and `incident_revisions.view`, and as embedded in `outbox.payload.incident`.

| ew-1 field | Cited at | ew-2 location | Rule |
|---|---|---|---|
| `id` | contracts.ts:168 | `Event.id` | Verbatim. Must equal the row's `id` |
| `version` | contracts.ts:169 | `Event.version` | Verbatim. Must equal the row's `version` |
| `headline`, `summary_en`, `summary_it` | contracts.ts:170-172 | `text` | Verbatim |
| `activity` | contracts.ts:173 | `taxonomy` | Activity mapping table |
| `impact` | contracts.ts:174 | `severity` | Impact mapping table. `evidence_phrases: []` at event level |
| `evidence_status` | contracts.ts:175 | `evidence_state`, `source_authority`, `corrected` | Next table |
| `location` | contracts.ts:176-183 | `legacy_display` | Verbatim. `geometry: []` |
| `event_start`, `event_end` | contracts.ts:184-185 | `times.event` | `toTimeValue`. `timezone` and `uncertainty` `null` at event level |
| `published_at` | contracts.ts:186 | `times.published_at` | `toTimeValue` |
| `ingested_at` | contracts.ts:187 | `times.ingested_at` | Verbatim. It is the triggering revision's ingestion, not first ingestion |
| `analyzed_at` | contracts.ts:188 | `times.analyzed_at` | Verbatim |
| `updated_at` | contracts.ts:189 | `times.updated_at` | Verbatim |
| `expires_at` | contracts.ts:190 | `times.expires_at` | `toTimeValue` |
| `claims[]` | contracts.ts:191-195 | `claims[]` | EventClaim table, order kept |
| `reports[]` | contracts.ts:196 | `documents[]` | `{ ref: {report_id, content_revision ?? null}, retracted: retracted === true }`. Display fields come from `SourceDocument` |
| `reports[].rights` | index.ts:572, 1056 | none | A write-time snapshot. Reads already replace it from current policy (`refreshRights`, index.ts:188) |
| `reports[].source_name` | index.ts:564, 1045 | none | Resolved from the current source record |
| `history` | contracts.ts:197 | none | Always `[]` when stored (index.ts:575, 1101). The detail route builds it from `incident_revisions` (index.ts:2372) |
| `analysis_status` | contracts.ts:198 | `assessment` | `source_only` if present. Otherwise `pending_analysis` when `analyzed_at` is null, else `analysed` |
| `superseded_by` | contracts.ts:199 | `merged_into` | Verbatim. Also yields a `merged_into` relationship |
| `review_needed` | contracts.ts:200 | `review_needed` | Verbatim |
| `cancelled` | contracts.ts:201 | `cancelled` | Verbatim |
| row `known_at` or `updated_at` | 0001_initial.sql:10-11 | envelope `known_at` | `incident_revisions.known_at`, or `incidents.updated_at` for the current row |
| row `reason` | 0001_initial.sql:11 | `revision_reason` | Verbatim. `""` for the current row, which has no reason column |
| none | | `derivation` | `{ rule: "ew1-incident-view", version: "ew-1" }` |

Evidence status uses a bijection so v1 can be reconstructed exactly.

| ew-1 `evidence_status` | Written at | `evidence_state` | `source_authority` | `corrected` |
|---|---|---|---|---|
| `unverified` | index.ts:1076 | `reported` | `none_asserted` | `false` |
| `corroborated` | operator only, index.ts:2676-2681 | `corroborated` | `none_asserted` | `false` |
| `official_advisory` | index.ts:542, 1069 | `reported` | `official_issuer` | `false` |
| `disputed` | index.ts:1075 | `contested` | `none_asserted` | `false` |
| `corrected` | index.ts:621, 1073, 1254, 1903, 2241, 2252, 2284, 2298, 2722 | `unknown` | `none_asserted` | `true` |
| `retracted` | index.ts:1071, 1254 | `retracted` | `none_asserted` | `false` |

`corrected` overwrote whatever support state existed, so the honest mapping is `unknown`. `superseded` is not produced from ew-1 data. Merge lineage lives in `merged_into`, which keeps the alert equivalence in the Alert materiality section exact.

### Database rows

Schema from deploy/migrations 0001 to 0007. Drizzle 0000 to 0003 carry the same schema.

| Table (cited) | ew-2 mapping | Preservation rule |
|---|---|---|
| `sources` (0001:2) | Out of scope. Source policy registry | Unchanged. `rights_policy_version` is `null` because ew-1 rights carry only `verified_at` (contracts.ts:233) |
| `source_health` (0001:3) | Out of scope. Coverage dataset in a later PR | Unchanged |
| `observations` (0001:4, 0006:1) | `SourceDocument` identity and tombstones | `id` is `document_id`. `latest_revision` selects the current revision. `deleted_at` set gives a `Tombstone` with `reason: null`. `canonical_url = ''` decodes to `null`. `expires_at` is a retention schedule, not a document field |
| `observation_revisions` (0001:5) | `SourceDocument` | Key `(report_id, revision)` kept. `input` decodes under the ew-1 `ObservationInput` schema |
| `analysis_jobs` (0001:6, 0003:1) | Not a record. Dispatch key for analysis decoding | `contract_version` drives decoder choice. No change |
| `analysis_results` (0001:8) | `AnalysisRecord` | `result` decodes under `Analysis`. `run` decodes under `ModelRun` |
| `origin_groups` (0001:9) | `Provenance.upstream_origin_ids` | `id` is `sha256(canonical_url)` (index.ts:657, 1106). `independence` stays `'unknown'`. Shared origin means the same URL only |
| `incidents` (0001:10) | Current `Event` version or `Tombstone` | `view = '{}'` with `deleted_at` set gives `Tombstone` (index.ts:303, 2433). `{}` without `deleted_at` is a decode error |
| `incident_revisions` (0001:11) | Historical `Event` versions | `(incident_id, version)` kept. `known_at` and `reason` kept. Retention and source deletion delete these rows (index.ts:282-346, 2410-2482) |
| `claims` (0001:13) | Cross-check only | Never read by the server today. `claim` holds the raw model claim. `incident_id` is not updated by merge or split (index.ts:2205-2353), so the event version's embedded claims are authoritative |
| `evidence_links` (0001:14) | `derived_from` relationship from `Event` to `SourceDocument` | `revision = 'unknown'` (index.ts:2345) decodes to `revision: null`. `origin_id` goes to the document's `upstream_origin_ids` |
| `outbox` (0001:15) | Not a record | `incident` payloads decode through the event dispatcher. SSE output is unchanged in PR 1 |
| `workers`, `queue_counters`, `collector_config`, `analysis_bundles`, `bundle_members` (0001:16, 0004:11, 0004:22, 0005:3-4) | Not records | Unchanged |
| `watch_areas` (0001:17) | Owner-private input to alerts | `geometry` is read by `intersects` (alerts.ts:208) as a bbox or Polygon. Unchanged in PR 1 |
| `alert_rules` (0001:18) | Owner-private input to alerts | `AlertRule` (alerts.ts:3-12) unchanged. `activities` filters keep ew-1 values |
| `alert_deliveries` (0001:19) | Unchanged | `(incident_id, incident_version)` addresses an `Event` version. Delivery id `sha256(incident:version:rule:rule_version)` unchanged (index.ts:268). No material version is persisted today |
| `annotations` (0001:20) | Unchanged | Free-form audit notes |
| `brief_windows`, `brief_evidence` (0007:2-8) | Out of scope | The brief has its own contract (`BRIEF_CONTRACT_VERSION`, src/shared/brief.ts) |

`/api/operator/import` (index.ts:2107) copies rows column by column, so imported rows keep their ids and decode the same way.

## Identity preservation rules

- **IDs are never regenerated.** Document ids stay `sha256(source_id:native_id)` (`ingest`, index.ts:386). Revisions stay the content hash (index.ts:387-395). Event ids stay as assigned (index.ts:526, 989, 2273). Claim ids stay `${analysis_id}:${local}`. Analysis ids stay `sha256("analysis:" + job_id)`.
- **Evidence IDs stay verbatim.** Excerpt ids are adapter-chosen and unique only within one document revision. The qualified key is `(document_id, revision, evidence_id)`. No global evidence id is minted, and no excerpt id is rewritten.
- **Revisions and versions continue.** The first ew-2 write to an existing event uses `version + 1` on the same id. One event's history may hold ew-1 versions followed by ew-2 versions, and each version decodes under its own schema.
- **Tombstones are terminal.** A tombstone decodes to `Tombstone` and is never reconstructed into an event. Ingest of a deleted observation is still refused (`ingest`, the `existing?.deleted_at` branch). `alert_deliveries` rows that point at a tombstoned event decode with an unknown material version, which is today's behaviour (`lastAlertDelivery`, index.ts:203-244).
- **New event ids come from immutable source identity.** ew-2 writers keep the current rule of hashing source identity plus claim index and never derive an id from title or location. Manual split keeps a random UUID (index.ts:2273). The similarity-based reuse of an existing incident id in `complete` (index.ts:1000-1024) stays as ew-1 behaviour in PR 1 (open question 10).

## Decoder dispatch

New module `src/shared/decode.ts`. A record's version is read from its own payload. ew-1 payloads have no `schema_version` key, so absence means ew-1. Unknown versions and shape mismatches fail with a typed error, never with a silent `null`.

```ts
export type DecodeErrorCode =
  | "unreadable_json"
  | "unsupported_schema_version"
  | "ew1_shape_mismatch"
  | "ew2_shape_mismatch"
  | "row_view_identity_mismatch"
  | "tombstone_with_payload"
  | "payload_missing";

export class RecordDecodeError extends Error {
  constructor(
    readonly code: DecodeErrorCode,
    readonly table: z.infer<typeof LegacyRef>["table"],
    readonly key: (string | number)[],
    readonly issues: string[] = [],
  ) {
    super(code);
  }
}

type EventRow = {
  id: string;
  version: number;
  view: string;
  deleted_at?: string | null;
  known_at?: string; // incident_revisions
  updated_at?: string; // incidents
  reason?: string;
};
export type DecodedEvent =
  | { kind: "event"; source_version: "ew-1" | "ew-2"; event: z.infer<typeof Event> }
  | { kind: "tombstone"; tombstone: z.infer<typeof Tombstone> };

const Versioned = z.object({ schema_version: z.string() }).partial().passthrough();

const EVENT_DECODERS = {
  "ew-1": (raw: unknown, row: EventRow, table: "incidents" | "incident_revisions") =>
    eventFromEw1(IncidentViewEw1.parse(raw), row, table), // pure, in legacy-ew1.ts
  "ew-2": (raw: unknown) => Event.parse(raw),
} as const;

export function decodeEvent(row: EventRow, table: "incidents" | "incident_revisions"): DecodedEvent {
  const key = [row.id, row.version];
  if (row.deleted_at) {
    if (row.view !== "{}") throw new RecordDecodeError("tombstone_with_payload", table, key);
    return { kind: "tombstone", tombstone: tombstoneFromRow(row, table) };
  }
  if (row.view === "{}") throw new RecordDecodeError("payload_missing", table, key);
  let raw: unknown;
  try {
    raw = JSON.parse(row.view);
  } catch {
    throw new RecordDecodeError("unreadable_json", table, key);
  }
  const version = Versioned.safeParse(raw).data?.schema_version ?? "ew-1";
  const decode = EVENT_DECODERS[version as keyof typeof EVENT_DECODERS];
  if (!decode) throw new RecordDecodeError("unsupported_schema_version", table, key, [version]);
  const parsed = /* run decode, convert ZodError to ew1_/ew2_shape_mismatch with issue paths */;
  if (parsed.id !== row.id || parsed.version !== row.version)
    throw new RecordDecodeError("row_view_identity_mismatch", table, key);
  return { kind: "event", source_version: version as "ew-1" | "ew-2", event: parsed };
}
```

The same pattern covers `decodeSourceDocument` (`observation_revisions.input`), `decodeAnalysis` (`analysis_results.result` and `run`, dispatched on `analysis_jobs.contract_version` with the `:review:<v>` suffix stripped) and `decodeOutboxIncident`.

Decoders are pure. They read neither the clock nor current source policy, run no validators and perform no I/O. Rebuilding a v1 view from an ew-2 event needs `SourceDocument` lookups for report display fields, so that function takes a resolver argument and lives beside the decoders.

The ew-1 schemas are written as zod in `src/shared/legacy-ew1.ts` and replace the `IncidentView` TypeScript type, which removes `any` from `reports` and `history` (contracts.ts:196-197).

```ts
const Ew1Location = z
  .object({
    name: z.string(),
    country: z.string().nullable(),
    lon: z.number(),
    lat: z.number(),
    accuracy: z.enum(["point", "city", "country", "area"]),
    radius_km: z.number(),
  })
  .strict();

const Ew1Report = z
  .object({
    report_id: z.string(),
    source_id: z.string(),
    source_name: z.string().optional(), // absent on retraction entries (index.ts:1236-1248)
    canonical_url: z.string(),
    content_revision: z.string().optional(), // merge tolerates absence (index.ts:2345)
    title: z.string(),
    excerpts: z.array(Evidence),
    input_coverage: z.enum(["full_licensed_text", "permitted_excerpt", "title_only"]),
    published_at: z.string().nullable(),
    original_language: z.string().optional(), // absent on retraction entries
    source_event_id: z.string().optional(),
    source_metadata: z
      .object({ publisher_generated: z.boolean(), alarm_count: z.number().optional() })
      .strict()
      .optional(),
    source_reports: z
      .array(z.object({ native_id: z.string(), canonical_url: z.string(), published_at: z.string().nullable() }).strict())
      .optional(),
    rights: SourceRights.optional(), // SourceRecord["rights"] as zod, contracts.ts:222-231
    retracted: z.literal(true).optional(),
  })
  .strict();

const Ew1ViewClaim = Claim.extend({
  model_claim_id: z.string().optional(),
  report_id: z.string().optional(),
  content_revision: z.string().optional(),
});

export const IncidentViewEw1 = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    headline: z.string(),
    summary_en: z.string(),
    summary_it: z.string().nullable(),
    activity: Activity,
    impact: Impact,
    evidence_status: z.enum([
      "unverified", "corroborated", "official_advisory", "disputed", "corrected", "retracted",
    ]),
    location: Ew1Location.nullable(),
    event_start: z.string().nullable(),
    event_end: z.string().nullable(),
    published_at: z.string().nullable(),
    ingested_at: z.string(),
    analyzed_at: z.string().nullable(),
    updated_at: z.string(),
    expires_at: z.string().nullable(),
    claims: z.array(Ew1ViewClaim),
    reports: z.array(Ew1Report),
    history: z.array(z.unknown()).max(0),
    analysis_status: z.literal("source_only").optional(),
    superseded_by: z.string().optional(),
    review_needed: z.boolean(),
    cancelled: z.boolean(),
  })
  .strict();
export type IncidentView = z.infer<typeof IncidentViewEw1>;
```

The optional keys are exactly the shapes the current write paths produce. Rows written by earlier code may differ, and the git history does not show earlier shapes because it is squashed. Any such row fails as `ew1_shape_mismatch` and needs a deliberate schema extension (open question 5).

## Lossy and unknown

These facts are absent from ew-1 storage. The mapping records them as `null`, `not_recorded` or a quality flag and never fills them in.

1. Reference time for `temporal_status`. The worker's `at` is not stored (wire.ts:88-93).
2. Place resolution status and candidates. `resolveClaimLocations` (geo.ts:54-130) keeps only the result.
3. Origin of an incident location (source, gazetteer, country centroid or operator). Hence no v2 geometry for ew-1 events.
4. Severity rule version for accepted claims. PR 0 changed the rule and nothing records which rule accepted a given claim.
5. The support state behind `evidence_status = "corrected"`.
6. Tombstone reason (retention versus source deletion). Deleted revisions and claims leave only id, last version and `deleted_at`.
7. Revision of some evidence links (`'unknown'`, index.ts:2345).
8. Whether a claim inside a view was edited by an operator. Only the revision `reason` hints at it.
9. Targets of model relationships, which are free text, and the meaning of ew-1 `origin`.
10. Validity of `candidate_incident_ids`.
11. The write-time rights snapshot and source name in `reports[]`. v1 reconstruction uses current values, as reads already do.
12. The target of a CAP supersession on an ancestor incident (index.ts:609-652 records only "explicit issuer CAP reference"). No `supersedes` relationship is reconstructed.
13. Split lineage, which exists only in revision reasons (`split claims into <id>`, `split from <id>`, index.ts:2273-2300). It is reconstructed as `split_from` only when both sides agree (the new event's version 1 says `split from X` and X has a revision saying `split claims into <new id>`), because operator correction reasons are free text and could begin with the same words.
14. Parser version and rights policy version.
15. Origin independence. `origin_groups.independence` is always `'unknown'`.
16. Whether an absent `official.cancelled` meant false. Incident views collapse it to `false` (index.ts:577). Source documents keep `null`.

## Alert materiality

### Current behaviour

`alertMaterialityVersion` (alerts.ts:201-206) serialises a v1 projection (alerts.ts:26-79, 158-198). Nothing persists that string. `lastAlertDelivery` (index.ts:203-244) loads the delivered revision's view and recomputes the projection at decision time. An unreadable or purged view gives `material_version: null`, which `alertDecision` (alerts.ts:240) treats as unknown.

### Proposed v2

`alertMaterialityProjection(event, rule)` takes a decoded `Event`. Callers decode both the current view and the delivered view with `decodeEvent`. A `RecordDecodeError` or a tombstone on the delivered side keeps today's meaning, `material_version: null`. Catching that one typed error is the documented unknown state, not error suppression.

```ts
export type AlertMaterialityProjection = {
  version: 2;
  rule: { watch_area_id: string | null; impacts: string[]; activities: string[] };
  legacy_display: null | {
    name: string; country: string | null; lon: number; lat: number;
    accuracy: string; radius_km: number;
  };
  geometry: Array<{ role: string; geometry: string; valid_start: string | null; valid_end: string | null }>;
  timing: { event_start: string | null; event_end: string | null; expires_at: string | null };
  severity: {
    taxonomy: string; // `${domain}.${type}`
    legacy_activity: string | null;
    native: string;
    dimensions: Record<string, string | null>;
  };
  evidence: { state: string; source_authority: string; corrected: boolean };
  assertions: Array<{
    taxonomy: string;
    legacy_activity: string | null;
    native_impact: string;
    evidence_phrases: string[];
    violence: string | null;
    places: Array<{ name: string; country: string | null; admin: string | null; uncertainty: string | null }>;
    timing: {
      event_start: string | null; event_end: string | null; timezone: string | null;
      phase: string | null; uncertainty: string | null;
    };
    instruction: null | {
      issuer: string; instruction: string; effective_at: string | null; expires_at: string | null;
    };
    relationships: Array<{ type: string; target: string }>;
  }>;
  affected: string[]; // ids from `affects` relationships, empty for ew-1
  cancelled: boolean;
};
// alertMaterialityVersion returns `alert-material-v2:${JSON.stringify(projection)}`
```

Rules.

- The v1 projection, its type and the `alert-material-v1` prefix are deleted. There is one projection.
- `normalizedText`, `canonicalTime` and `sortedUnique` (alerts.ts:81-111) are reused unchanged. A `TimeValue` projects through `canonicalTime(value)`, and an `unparsed` value projects its `raw` text, which is what v1 does with the same string today.
- A comparison never mixes projection versions. Both sides are recomputed with the current version. If a future change persists material strings, a stored string with another prefix triggers recomputation from the delivered revision, and an unavailable revision yields `null`.
- `merged_into` and other ew-2-only lineage stay out of the projection in PR 1 (open question 7).

### Equivalence on ew-1 data

For an ew-1-decoded event, every v2 field is an injective function of fields v1 already projects. Taxonomy keeps the legacy activity. Native impact is the impact string. The evidence block is the bijection from `evidence_status`. `geometry` and `affected` are always empty. Therefore, for any two ew-1 event versions and any rule, v1 reports a material change exactly when v2 does. Existing alert decisions, suppression reasons and correction-recipient routing (`correctionAlerts`, index.ts:246-281) are unchanged. PR 1 must prove this by test rather than rely on the argument.

## Migration approach

### PR 1

PR 1 adds no migration and changes no rows.

- ew-1 rows are identified by the absence of `schema_version`, so no version column is needed.
- No ew-2 writer exists until PR 4.
- Decoding costs CPU only. It reads no additional D1 rows, because the alert path already loads delivered views.
- `deploy/migrations/0001` to `0007` and `drizzle/0000` to `0003` stay byte-identical. AGENTS.md forbids rewriting applied migrations.

### First v2 migration

This is not part of PR 1. If the owner chooses to land ew-2 writes in D1 (open question 4), the first migration must follow these rules.

- Append `deploy/migrations/0008_v2_records.sql` and `drizzle/0004_v2_records.sql` with identical DDL. The drizzle file separates statements with `--> statement-breakpoint`, adds journal entry `idx: 4` to `drizzle/meta/_journal.json` and adds `meta/0004_snapshot.json` whose `prevId` is the id in `0003_snapshot.json`. The current correspondence is deploy 0001-0004 as drizzle 0000, deploy 0005 as drizzle 0001, 0006 as 0002 and 0007 as 0003.
- Keep it schema-only. Existing ew-1 rows are decoded, not backfilled.
- Extend every deletion path in the same change. `enforceRetention` (index.ts:282-346) and source deletion (index.ts:2410-2482) must delete relationship rows that reference purged documents or events inside the same batch, as AGENTS.md requires for derived data.
- Add the fresh-versus-upgraded parity check from TODO T04 for both sequences.

Proposed DDL, for review only.

```sql
CREATE TABLE relationships(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_type TEXT NOT NULL, from_id TEXT NOT NULL, from_version TEXT,
  to_type TEXT, to_id TEXT, to_version TEXT, to_text TEXT,
  basis_kind TEXT NOT NULL, basis_id TEXT NOT NULL, basis_version TEXT,
  record TEXT NOT NULL,
  valid_from TEXT NOT NULL, valid_to TEXT,
  CHECK((to_id IS NULL) <> (to_text IS NULL))
);
CREATE INDEX relationships_from ON relationships(from_id, type);
CREATE INDEX relationships_to ON relationships(to_id, type) WHERE to_id IS NOT NULL;
```

ew-2 events and documents would keep using `incidents.view`, `incident_revisions.view` and `observation_revisions.input`, with `schema_version` inside the JSON.

## Open questions

Each has a proposed default that PR 1 assumes unless the owner decides otherwise.

1. **Domain naming and rule.** Is `public_activity` the right id, and is entailment-only assignment acceptable even though it leaves 7 of 17 legacy values `unclassified`? Default is yes.
2. **Humanitarian domain.** Should `displacement` get a `humanitarian` domain? Default is no until a source needs it.
3. **Meaning of `origin`.** The prompt never defines the ew-1 `origin` relationship. Default maps it to `derived_from` with `basis: legacy_ew1`.
4. **Where ew-2 writes land.** Either D1 before PostgreSQL (needs migration 0008/0004 before PR 4) or PostgreSQL only after PR 3. Default assumes PR 4 follows PR 3, so D1 never receives ew-2 writes and no D1 migration is needed.
5. **Production decode audit.** May the owner provide a permitted, read-only export of the paused deployment so the ew-1 decoders can be run offline against real rows? Without it, acceptance covers fixtures only and says so.
6. **Severity rule provenance.** Where should acceptance record `SEVERITY_RULE_VERSION` for new ew-1 results? Default adds a host-owned `host_rules` object next to `run` in PR 2. It is not written in PR 1.
7. **Merge lineage in alerts.** Adding `merged_into` to the materiality projection would make merging an already cancelled incident a material change, which breaks the PR 1 equivalence. Default excludes it in PR 1 and revisits in PR 5.
8. **Split lineage.** Accept split relationships reconstructed only when both revision reasons agree? Default is yes. Otherwise split lineage is left unmapped.
9. **Constant naming.** Rename `CONTRACT_VERSION` to `ANALYSIS_CONTRACT_VERSION` so it cannot be confused with `SCHEMA_VERSION`? Default is yes in PR 1, as a pure rename across contracts.ts, index.ts, adapter.ts and eval.ts.
10. **Similarity-based incident reuse.** `complete` reuses an existing incident id when location, time and headline words are close (index.ts:1000-1024), which is identity from mutable fields. Default keeps it in PR 1 and replaces it with `possible_same_event` candidates in PR 6.
11. **Legacy geography in spatial alerts.** In PR 5, should ew-1 events keep alerting through the point+radius approximation (`intersects`, alerts.ts:208) with today's "broad_area_notice" reason, or require v2 geometry? Default keeps the approximation for ew-1 events only.
12. **Operator corroboration.** ew-1 `corroborated` is only ever set by an operator. Default maps it to `corroborated` and relies on the revision reason to show it was operator-asserted.

## Acceptance checklist

PR 1 is acceptable when all of these hold. None of them has been run.

- [ ] zod schemas exist for every stored ew-1 JSON shape, meaning incident views (incidents, incident_revisions, outbox), `claims.claim`, `analysis_results.result` and `.run`, and `observation_revisions.input`. `IncidentView` is derived from `IncidentViewEw1` with no `any` in `reports` or `history`.
- [ ] A committed fixture corpus is generated by driving the existing disposable-database test harness (`tests/server.test.ts`) through every write path. Those paths are official create, update, cancel and ancestor supersession in `ingest`, analysis acceptance and source revision in `complete`, source-only retention, retraction and correction after a source revision, BBK complete-feed reconciliation, manual merge and split, operator correction, the retention tombstone and the source-deletion tombstone. Fixtures come from test sources only, never from production data.
- [ ] Every corpus record decodes under ew-1, maps to ew-2 and passes the strict ew-2 schema.
- [ ] Ids, versions, revisions, evidence ids, `known_at` and revision reasons are identical before and after mapping.
- [ ] Rebuilding a v1 view from the ew-2 event plus `SourceDocument` lookups equals the stored view, except `reports[].rights` and `reports[].source_name`.
- [ ] Each unsupported input fails with its own code. That covers an unknown `schema_version`, an extra key in an ew-1 view, an unknown activity, an id or version mismatch with the row, a tombstone carrying a payload, a missing payload and malformed JSON.
- [ ] Decoding is deterministic and pure. The same inputs under a frozen clock and changed source policy produce identical output, and no validator runs.
- [ ] `Activity` and `Impact` mappings are exhaustive at compile time (`satisfies Record<…>`) and a test iterates `Activity.options` and `Impact.options`.
- [ ] Temporal tests show date-only values keep `date` precision, null stays null, an unparseable official `effective_at` survives as `unparsed`, `analyzed_at` never appears in an event interval, and an Observation fails when `kind` and `forecast` disagree.
- [ ] Geometry tests cover coordinate ranges, an unclosed ring, a ring shorter than four positions, a polygon with a hole, a MultiPolygon and an unsplit antimeridian segment. A type-level test shows `LegacyPointRadius` cannot be placed in `geometry[]` and always has `calibrated: false`.
- [ ] For every ordered pair of corpus event versions and every rule fixture, v1 material equality equals v2 material equality. `tests/alerts.test.ts`, `tests/server-alerts.test.ts` and `tests/pr0-alert-integration.test.ts` pass with only the version prefix expectation changed.
- [ ] Job identity is unchanged. Re-ingesting an unchanged revision creates no new job, and the job id and worker spool key match pre-PR 1 values for the same input.
- [ ] `/api/snapshot`, `/api/events`, `/api/export` and the incident detail route return byte-identical bodies for the corpus before and after PR 1.
- [ ] No file under `deploy/migrations/` or `drizzle/` changes, and the Sites build journal check in `scripts/build-sites.mjs` is unaffected.
- [ ] `npm run check`, `npm test`, `npm run build` and `npm run audit:public` pass offline. No collector, worker, deployment or migration command is run, as AGENTS.md requires while the project is paused.
- [ ] If open question 5 is approved, the offline decode audit over the permitted export reports zero shape mismatches, or each mismatch is resolved by an explicit, reviewed schema extension.

## Out of scope

- New incident categories, taxonomy types beyond the ew-1 mapping, or changes to source inventory categories.
- New feeds, adapters or source registry entries, including USGS, GDACS and global FIRMS.
- Infrastructure work such as PostgreSQL/PostGIS, object storage, new queues, new tables or D1 migrations.
- UI and client changes. The client keeps consuming v1 `IncidentView`.
- `/v2` API endpoints, SSE envelope changes and export format changes.
- Analysis prompt, wire contract or model changes, and any re-analysis of stored reports.
- Alert behaviour changes beyond replacing the projection version, including spatial alert geometry and correction routing.
- Brief contract and brief storage.
- Persisting ew-2 records, relationships or geometry assertions.
