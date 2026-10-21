import { z } from "zod";
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
  };
  official?: {
    issuer: string;
    effective_at: string | null;
    expires_at: string | null;
    cancelled?: boolean;
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
};
export type SourceRecord = {
  id: string;
  name: string;
  owner: string;
  url: string;
  docs: string;
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
    if (
      ["severe", "critical"].includes(c.impact) &&
      c.violence_mentioned !== "yes" &&
      !c.official_instruction
    )
      throw Error("unsupported_escalation");
  }
  return r;
}
