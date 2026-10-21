import { z } from "zod";
import { Claim, validateResult, type JobInput } from "../shared/contracts.js";
const WireTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/,
  )
  .nullable();
const WireClaim = Claim.extend({
  event_start: WireTime,
  event_end: WireTime,
  official_instruction: Claim.shape.official_instruction
    .unwrap()
    .extend({
      effective_at: WireTime,
      expires_at: WireTime,
    })
    .nullable(),
});
export const WireResult = z
  .object({
    index: z.number().int().nonnegative(),
    language: z.string(),
    relevant: z.boolean(),
    reason: z.string().max(240),
    summary: z.string().max(600),
    italian: z.string().max(600).nullable(),
    claims: z.array(WireClaim),
    uncertainty: z.array(z.string()),
    review: z.boolean(),
  })
  .strict();
export const WireBatch = z.object({ results: z.array(WireResult) }).strict();
function evidenceText(input: JobInput, excerpt: JobInput["excerpts"][number]) {
  const demos =
    input.source_id === "de-demos-assemblies" &&
    excerpt.id === "licensed-event-metadata";
  const idmc =
    input.source_id === "ua-idmc-displacement-flows" &&
    excerpt.id === "licensed-flow-metadata";
  if (!demos && !idmc) return excerpt.text;
  try {
    const value = JSON.parse(excerpt.text);
    if (!value || Array.isArray(value) || typeof value !== "object")
      return excerpt.text;
    if (
      demos &&
      (typeof value.event_title !== "string" ||
        typeof value.event_start_local !== "string" ||
        !Array.isArray(value.public_locations))
    )
      return excerpt.text;
    if (
      idmc &&
      (typeof value.displacement_type !== "string" ||
        !Number.isFinite(value.figure) ||
        typeof value.displacement_started_on !== "string")
    )
      return excerpt.text;
    // The stored source and UI retain provenance. Only known adapter envelopes
    // are omitted from inference; every unknown field and material fact stays.
    const omitted = new Set(
      demos
        ? [
            "attribution",
            "license_url",
            "upstream_reference",
            "aggregator_record_created_at",
            "aggregator_record_updated_at",
          ]
        : [
            "attribution",
            "upstream_reference",
            "source_record_created_at",
            "record_id",
            "upstream_event_id",
          ],
    );
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !omitted.has(key)),
      ),
    );
  } catch {
    return excerpt.text;
  }
}
export function compactInputs(
  inputs: JobInput[],
  at = new Date().toISOString(),
) {
  return {
    at,
    italian: process.env.EW_ANALYSIS_ITALIAN === "true",
    reports: inputs.map((r, i) => {
      const excerpts = r.excerpts.map((excerpt) => ({
        id: excerpt.id,
        text: evidenceText(r, excerpt),
      }));
      const envelopeCompacted = r.excerpts.some(
        (excerpt, index) => excerpt.text !== excerpts[index].text,
      );
      return {
        index: i,
        language: r.original_language,
        coverage: r.input_coverage,
        ...(!r.excerpts.some((e) => e.text.includes(r.title))
          ? { title: r.title }
          : {}),
        ...(r.published_at ? { published: r.published_at } : {}),
        ...(r.source_updated_at && !envelopeCompacted
          ? { updated: r.source_updated_at }
          : {}),
        ...(r.official ? { official: r.official } : {}),
        ...(r.source_geo
          ? {
              reported_place: {
                name: r.source_geo.name,
                accuracy: r.source_geo.accuracy,
              },
            }
          : {}),
        excerpts,
      };
    }),
  };
}
export function restoreResult(
  item: z.infer<typeof WireResult>,
  input: JobInput,
) {
  return validateResult(
    {
      report_id: input.report_id,
      content_revision: input.content_revision,
      input_coverage: input.input_coverage,
      published_at: input.published_at,
      source_updated_at: input.source_updated_at,
      original_language: item.language,
      relevant: item.relevant,
      relevance_reason: item.reason,
      summary_en: item.summary,
      summary_it: item.italian,
      claims: item.claims,
      candidate_incident_ids: [],
      uncertainty_flags: item.uncertainty,
      targeted_review: item.review,
    },
    input,
  );
}
