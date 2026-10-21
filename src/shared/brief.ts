import { z } from "zod";
import { validEventTime } from "./contracts.js";
export const BRIEF_CONTRACT_VERSION = "ew-brief-1";
export const BriefIncidentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    incident_id: z.string().min(1),
    headline: z.string().max(200),
    summary: z.string().max(600),
    source_title: z.string().max(160).optional(),
    impact: z.string(),
    evidence_status: z.string(),
    activity: z.string().nullable(),
    event_start: z.string().nullable(),
    event_end: z.string().nullable(),
    updated_at: z.string(),
    source_count: z.number().int().nonnegative(),
    cancelled: z.boolean(),
    pin_eligible: z.boolean(),
  })
  .strict();
export const BriefInputSchema = z
  .object({
    window_start: z.string(),
    window_end: z.string(),
    incidents: z.array(BriefIncidentSchema).min(1).max(50),
    counts: z
      .object({
        reports: z.number().int().nonnegative(),
        incidents: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        omitted: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !validEventTime(value.window_start) ||
      !validEventTime(value.window_end) ||
      Date.parse(value.window_end) - Date.parse(value.window_start) !== 300000
    )
      ctx.addIssue({ code: "custom", message: "invalid_brief_window" });
    if (
      new Set(value.incidents.map((i) => i.index)).size !==
      value.incidents.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate_brief_indices" });
  });
export const BriefLeaseSchema = z
  .object({
    id: z.string().min(1),
    token: z.string().min(1),
    expires_at: z.string(),
    report_ids: z.array(z.string().min(1)).max(80),
    input: BriefInputSchema,
  })
  .strict();
export const BriefResultSchema = z
  .object({
    headline: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine(
        (s) => !/[\r\n]/.test(s) && s.split(/\s+/u).length <= 30,
        "headline_max_30_words",
      ),
    references: z.array(z.number().int().nonnegative()).min(1).max(12),
    pinned: z.array(z.number().int().nonnegative()).max(3),
  })
  .strict();
export type BriefIncident = z.infer<typeof BriefIncidentSchema>;
export type BriefInput = z.infer<typeof BriefInputSchema>;
export type BriefLease = z.infer<typeof BriefLeaseSchema>;
export type BriefResult = z.infer<typeof BriefResultSchema>;
export function validateBriefResult(
  result: unknown,
  input: BriefInput,
): BriefResult {
  const value = BriefResultSchema.parse(result),
    indices = new Set(input.incidents.map((i) => i.index));
  for (const list of [value.references, value.pinned])
    if (new Set(list).size !== list.length || list.some((i) => !indices.has(i)))
      throw Error("invalid_brief_reference");
  if (
    value.pinned.some(
      (index) => !input.incidents.find((i) => i.index === index)?.pin_eligible,
    )
  )
    throw Error("ineligible_brief_pin");
  if (value.pinned.some((index) => !value.references.includes(index)))
    throw Error("uncited_brief_pin");
  return value;
}
