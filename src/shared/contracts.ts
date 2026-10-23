import { z } from "zod";
import { validateSeverity } from "./severity.js";
import type { Footprint } from "./footprint.js";
export const CONTRACT_VERSION = "ew-1";
export const Impact = z.enum([
  "informational",
  "minor",
  "significant",
  "severe",
  "critical",
  "unknown",
]);
export const Activity = z.enum([
  "planned_demonstration",
  "ongoing_demonstration",
  "strike",
  "gathering",
  "disruption",
  "confrontation",
  "reported_violence",
  "property_damage_fire",
  "displacement",
  "official_advisory",
  "earthquake",
  "tropical_cyclone",
  "flood",
  "wildfire",
  "volcanic_eruption",
  "drought",
  "severe_weather",
  "aviation_emergency",
  "volcanic_ash",
  "conflict_zone_advisory",
  "connectivity_disruption",
  "other_unknown",
]);
export const Evidence = z.object({ id: z.string(), text: z.string() }).strict();
export const Place = z
  .object({
    name: z.string(),
    country: z.string().nullable(),
    admin: z.string().nullable(),
    evidence_ids: z.array(z.string()),
    uncertainty: z.string().nullable(),
  })
  .strict();
export const Claim = z
  .object({
    id: z.string(),
    activity: Activity,
    summary: z.string(),
    evidence_ids: z.array(z.string()),
    places: z.array(Place),
    event_start: z.string().nullable(),
    event_end: z.string().nullable(),
    timezone: z.string().nullable(),
    temporal_status: z.enum(["planned", "current", "historical", "unknown"]),
    time_uncertainty: z.string().nullable(),
    impacts: z.array(z.string()),
    violence_mentioned: z.enum(["yes", "no", "unclear"]),
    impact: Impact,
    impact_uncertainty: z.string().nullable(),
    official_instruction: z
      .object({
        issuer: z.string(),
        instruction: z.string(),
        effective_at: z.string().nullable(),
        expires_at: z.string().nullable(),
        evidence_ids: z.array(z.string()),
      })
      .strict()
      .nullable(),
    relationships: z.array(
      z
        .object({
          type: z.enum([
            "supports",
            "contradicts",
            "corrects",
            "retracts",
            "possible_duplicate",
            "origin",
          ]),
          target: z.string(),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export const Analysis = z
  .object({
    report_id: z.string(),
    content_revision: z.string(),
    input_coverage: z.enum([
      "full_licensed_text",
      "permitted_excerpt",
      "title_only",
    ]),
    original_language: z.string(),
    relevant: z.boolean(),
    relevance_reason: z.string(),
    summary_en: z.string(),
    summary_it: z.string().nullable(),
    published_at: z.string().nullable(),
    source_updated_at: z.string().nullable(),
    claims: z.array(Claim),
    candidate_incident_ids: z.array(z.string()),
    uncertainty_flags: z.array(z.string()),
    targeted_review: z.boolean(),
  })
  .strict();
export const Batch = z
  .object({
    contract_version: z.literal(CONTRACT_VERSION),
    results: z.array(Analysis),
  })
  .strict();
export type AnalysisResult = z.infer<typeof Analysis>;
export type EventClaim = z.infer<typeof Claim>;
export type ObservationInput = {
  source_id: string;
  native_id: string;
  canonical_url: string;
  title: string;
  original_language: string;
  published_at: string | null;
  source_updated_at: string | null;
  input_coverage: "full_licensed_text" | "permitted_excerpt" | "title_only";
  excerpts: z.infer<typeof Evidence>[];
  source_geo?: {
    lon: number;
    lat: number;
    name: string;
    accuracy: "point" | "city" | "country" | "area";
    radius_km?: number;
    /** ISO 3166-1 alpha-2 code stated by the source or derived offline from its exact point; null when neither settles one country. */
    country?: string | null;
  };
  /** Issuer geometry, separate from source_geo, which stays the display point. */
  footprint?: Footprint;
  official?: {
    issuer: string;
    effective_at: string | null;
    expires_at: string | null;
    /** Deterministic classification from native structured fields; absent means a generic advisory of unknown impact. */
    activity?: z.infer<typeof Activity>;
    impact?: z.infer<typeof Impact>;
    cancelled?: boolean;
    /** The issuer lists the event as current and states no expiry. It stays live until reconciliation of the issuer's complete current list no longer finds it. */
    current_listing?: boolean;
    /** A self-report relayed by the source, such as a transponder code, that no authority has confirmed. It publishes as unverified, not as an official advisory. */
    self_reported?: boolean;
    references?: string[];
    message_type?: string;
  };
  source_event_id?: string;
  source_metadata?: { publisher_generated: boolean; alarm_count?: number };
  source_reports?: { native_id: string; canonical_url: string; published_at: string | null }[];
  eligibility?: { eligible: boolean; reason: string; policy_version: string };
  priority?: number;
};
export type JobInput = ObservationInput & {
  report_id: string;
  content_revision: string;
  contract_version: string;
  first_observed_at: string;
  ingested_at: string;
};
export type Lease = {
  job_id: string;
  attempt_id: string;
  fence: number;
  lease_until: string;
  input: JobInput;
};
export type ModelRun = {
  invocation_id?: string;
  requested_model: string;
  requested_tier: string;
  actual_model: string | null;
  actual_tier: string | null;
  client_version: string;
  prompt_version: string;
  schema_version: string;
  duration_ms: number;
  usage: unknown;
  tool_attempts: number;
  /** Configured provider id for chat-completions runs; absent for the Codex transport. */
  provider?: string;
  /** Base URL that served the run, without credentials. */
  endpoint?: string;
  /** Providers tried and left for this invocation, in order, before the one that served it. */
  switches?: { provider: string; model: string; reason: string }[];
};
export type IncidentView = {
  id: string;
  version: number;
  headline: string;
  summary_en: string;
  summary_it: string | null;
  activity: string;
  impact: z.infer<typeof Impact>;
  evidence_status: string;
  location: {
    name: string;
    country: string | null;
    lon: number;
    lat: number;
    accuracy: string;
    radius_km: number;
  } | null;
  /** The issuer's own geometry; location stays the marker and the spatial index key. */
  footprint?: Footprint;
  event_start: string | null;
  event_end: string | null;
  published_at: string | null;
  ingested_at: string;
  analyzed_at: string | null;
  updated_at: string;
  expires_at: string | null;
  claims: (EventClaim & {
    report_id?: string;
    content_revision?: string;
    model_claim_id?: string;
  })[];
  reports: any[];
  history: any[];
  analysis_status?: "source_only";
  superseded_by?: string;
  review_needed: boolean;
  cancelled: boolean;
  /** Live while its issuer lists it as current; false once the issuer stops listing it. */
  current_listing?: boolean;
  /** Same-event assessments against other incidents, mirrored on both. Absent means none. */
  links?: IncidentLink[];
};
/**
 * same_event joins two records of one occurrence into one situation without changing either.
 * possible_same_event points at a compatible record whose evidence does not settle identity.
 * split_from is an operator decision that the two differ, which no rule overrides.
 * independence says whether a same_event pair shares one upstream origin (republication) or
 * comes from independent origins (corroboration); unknown when a record states no origin.
 */
export type IncidentLink = {
  incident_id: string;
  type: "same_event" | "possible_same_event" | "split_from";
  independence?: "same_origin" | "independent" | "unknown";
  /** The rule and its version, or "operator". */
  basis: string;
  reason: string;
};
export type SourceRecord = {
  id: string;
  name: string;
  owner: string;
  url: string;
  docs: string;
  /** ISO 3166-1 alpha-2 codes, or ["*"] for a worldwide source. */
  countries: string[];
  languages: string[];
  categories: string[];
  family:
    "rss" | "bbk" | "tfl" | "gtfs_rt" | "social" | "gdelt" | "dwd" | "siri";
  status:
    | "enabled"
    | "awaiting_credentials"
    | "license_required"
    | "degraded"
    | "unsupported"
    | "disabled";
  poll_seconds: number;
  rights: {
    access: boolean;
    storage: boolean;
    ai: boolean;
    display: boolean;
    redistribute: boolean;
    basis: string;
    attribution: string;
    retention_days: number;
  };
  config: Record<string, unknown>;
  verified_at: string | null;
};
export function validEventTime(value: string | null) {
  if (value === null) return true;
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(
      value,
    )
  )
    return false;
  const date = Date.parse(value.slice(0, 10) + "T00:00:00Z");
  return (
    Number.isFinite(Date.parse(value)) &&
    Number.isFinite(date) &&
    new Date(date).toISOString().slice(0, 10) === value.slice(0, 10)
  );
}
export function validateResult(value: unknown, input: JobInput) {
  const r = Analysis.parse(value);
  if (
    r.report_id !== input.report_id ||
    r.content_revision !== input.content_revision ||
    r.input_coverage !== input.input_coverage
  )
    throw Error("analysis_identity_mismatch");
  if (
    r.published_at !== input.published_at ||
    r.source_updated_at !== input.source_updated_at
  )
    throw Error("source_time_mismatch");
  if (!r.relevant && r.claims.length)
    throw Error("irrelevant_report_has_claims");
  if (new Set(r.claims.map((c) => c.id)).size !== r.claims.length)
    throw Error("duplicate_claim_ids");
  const ids = new Set(input.excerpts.map((e) => e.id));
  for (const c of r.claims) {
    if (
      [
        c.event_start,
        c.event_end,
        c.official_instruction?.effective_at ?? null,
        c.official_instruction?.expires_at ?? null,
      ].some((t) => !validEventTime(t))
    )
      throw Error("invalid_event_time");
    const refs = [
      ...c.evidence_ids,
      ...c.places.flatMap((p) => p.evidence_ids),
      ...(c.official_instruction?.evidence_ids ?? []),
    ];
    if (!c.evidence_ids.length || refs.some((id) => !ids.has(id)))
      throw Error("unsupported_evidence");
    validateSeverity(c, input);
  }
  return r;
}
