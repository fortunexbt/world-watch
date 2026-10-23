import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CONTRACT_VERSION,
  type EventClaim,
  type JobInput,
  type ModelRun,
} from "../shared/contracts.js";
import { analyze, analysisKey, type AnalyzeOptions } from "./adapter.js";
import { invalidRule } from "./worker.js";

/**
 * A discovered news record. Only the headline is model evidence: discovery
 * metadata grants no right to the article body, and a publisher's country
 * does not locate the event.
 */
export const Headline = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(600),
    url: z.string().url(),
    language: z.string().min(2).nullable().default(null),
    published_at: z.string().nullable().default(null),
    seen_at: z.string().nullable().default(null),
  })
  .strict();
export type Headline = z.input<typeof Headline>;
export type TriageCandidate =
  | {
      id: string;
      status: "accepted";
      relevant: boolean;
      reason: string;
      categories: EventClaim["activity"][];
      places: Omit<EventClaim["places"][number], "evidence_ids">[];
      review: boolean;
      run: ModelRun;
    }
  | { id: string; status: "rejected"; rule: string; run: ModelRun };

export function headlineInput(
  record: Headline,
  now = new Date().toISOString(),
): JobInput {
  const h = Headline.parse(record);
  return {
    source_id: "headline-triage",
    native_id: h.id,
    canonical_url: h.url,
    title: h.title,
    original_language: h.language ?? "und",
    published_at: h.published_at,
    source_updated_at: null,
    input_coverage: "title_only",
    excerpts: [{ id: "title", text: h.title }],
    report_id: "headline:" + h.id,
    content_revision: createHash("sha256").update(h.title).digest("hex"),
    contract_version: CONTRACT_VERSION,
    first_observed_at: h.seen_at ?? now,
    ingested_at: now,
  };
}

/** Triage headlines through the configured backend, twelve per invocation, with full host validation. */
export async function triageHeadlines(
  records: Headline[],
  options: AnalyzeOptions = {},
): Promise<TriageCandidate[]> {
  const inputs = records.map((r) => headlineInput(r)),
    out: TriageCandidate[] = [];
  for (let i = 0; i < inputs.length; i += 12) {
    const chunk = inputs.slice(i, i + 12),
      r = await analyze(chunk, options);
    for (const input of chunk) {
      const key = analysisKey(input),
        run = r.runs.get(key)!,
        result = r.accepted.get(key);
      out.push(
        result
          ? {
              id: input.native_id,
              status: "accepted",
              relevant: result.relevant,
              reason: result.relevance_reason,
              categories: [...new Set(result.claims.map((c) => c.activity))],
              places: result.claims.flatMap((c) =>
                c.places.map(({ evidence_ids, ...place }) => place),
              ),
              review: result.targeted_review,
              run,
            }
          : {
              id: input.native_id,
              status: "rejected",
              rule: invalidRule(r.invalid.get(key) ?? "missing_result"),
              run,
            },
      );
    }
  }
  return out;
}
