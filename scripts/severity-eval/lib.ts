import type { EventClaim, JobInput } from "../../src/shared/contracts.js";
import { CONSEQUENCE, normalize, validateSeverity } from "../../src/shared/severity.js";

export type PagerAlert = "green" | "yellow" | "orange" | "red";
export type EvalEvent = { qid: string; alert: PagerAlert };
export type EvalDocument = { id: string; qid: string; lang: string; text: string };
export type Dataset = { events: EvalEvent[]; documents: EvalDocument[] };

/** Ground truth: PAGER orange and red are the alert levels that mean significant expected losses. */
export const isSevereTruth = (alert: PagerAlert) => alert === "orange" || alert === "red";

export type Proposer = {
  name: string;
  describe: string;
  /** Returns the claim a model would emit for the document. Never calls a model. */
  propose(doc: EvalDocument): { impact: "minor" | "severe"; quote: string };
};

const sentences = (text: string) =>
  text.split(/(?<=[.!?。！？؟।۔])\s*/u).map((s) => s.trim()).filter(Boolean);

/** Always escalates and quotes the opening sentence. The upper bound on false escalation. */
export const eager: Proposer = {
  name: "eager",
  describe: "Always proposes severe and quotes the first sentence.",
  propose: (doc) => ({ impact: "severe", quote: sentences(doc.text)[0] ?? doc.text }),
};

/**
 * Escalates when any sentence contains a consequence keyword from the gate's own
 * lexicons, and quotes that sentence. It has no polarity handling, so "no damage was
 * reported" or "could cause deaths" count as hits. This isolates what the gate's
 * negation and hypothetical checks add on top of keyword spotting.
 */
export const lexicalAlarm: Proposer = {
  name: "lexical-alarm",
  describe: "Proposes severe when a sentence contains a consequence keyword and quotes it; no polarity handling.",
  propose(doc) {
    const hit = sentences(doc.text).find((s) => CONSEQUENCE.test(normalize(s)));
    return hit ? { impact: "severe", quote: hit } : { impact: "minor", quote: sentences(doc.text)[0] ?? doc.text };
  },
};

export const PROPOSERS = [eager, lexicalAlarm];

function jobFor(doc: EvalDocument): JobInput {
  return {
    source_id: "severity-eval",
    native_id: doc.id,
    canonical_url: "https://example.invalid/severity-eval",
    title: doc.id,
    original_language: doc.lang,
    published_at: null,
    source_updated_at: null,
    input_coverage: "permitted_excerpt",
    excerpts: [{ id: "e1", text: doc.text }],
    report_id: doc.id,
    content_revision: "eval",
    contract_version: "ew-1",
    first_observed_at: "2026-10-22T00:00:00Z",
    ingested_at: "2026-10-22T00:00:00Z",
  };
}

function claimFor(impact: "minor" | "severe", quote: string): EventClaim {
  return {
    id: "claim-1",
    activity: "earthquake",
    summary: "An earthquake is described.",
    evidence_ids: ["e1"],
    places: [],
    event_start: null,
    event_end: null,
    timezone: null,
    temporal_status: "unknown",
    time_uncertainty: null,
    impacts: [quote],
    violence_mentioned: "no",
    impact,
    impact_uncertainty: null,
    official_instruction: null,
    relationships: [],
  };
}

/** The severity the host would publish: the proposal if the gate accepts it, otherwise the lowest. */
export function gated(doc: EvalDocument, proposer: Proposer): boolean {
  const { impact, quote } = proposer.propose(doc);
  if (impact !== "severe") return false;
  try {
    validateSeverity(claimFor(impact, quote), jobFor(doc));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "unsupported_escalation") return false;
    throw error;
  }
}

export const ungated = (doc: EvalDocument, proposer: Proposer) => proposer.propose(doc).impact === "severe";

export type Confusion = { tp: number; fp: number; fn: number; tn: number };

export function confusion(rows: { truth: boolean; predicted: boolean }[]): Confusion {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) c[r.truth ? (r.predicted ? "tp" : "fn") : r.predicted ? "fp" : "tn"]++;
  return c;
}

const ratio = (n: number, d: number) => (d ? n / d : null);
export const precision = (c: Confusion) => ratio(c.tp, c.tp + c.fp);
export const recall = (c: Confusion) => ratio(c.tp, c.tp + c.fn);
/** Share of documents about non-severe events that were escalated. */
export const falseEscalationRate = (c: Confusion) => ratio(c.fp, c.fp + c.tn);

export function wilson(k: number, n: number, z = 1.959964): [number, number] | null {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [centre - half, centre + half];
}

/** Deterministic PRNG so the published intervals reproduce exactly. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Row = { qid: string; truth: boolean; ungated: boolean; gated: boolean };

/**
 * Percentile bootstrap that resamples whole events, because the documents of one event
 * are the same earthquake in different languages and are not independent.
 */
export function clusterBootstrap(
  rows: Row[],
  stat: (rows: Row[]) => number | null,
  { resamples = 10000, seed = 20261022 }: { resamples?: number; seed?: number } = {},
): [number, number] | null {
  const byEvent = new Map<string, Row[]>();
  for (const r of rows) byEvent.set(r.qid, [...(byEvent.get(r.qid) ?? []), r]);
  const clusters = [...byEvent.values()];
  const rand = mulberry32(seed);
  const draws: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sample: Row[] = [];
    for (let j = 0; j < clusters.length; j++) sample.push(...clusters[Math.floor(rand() * clusters.length)]!);
    const value = stat(sample);
    if (value !== null) draws.push(value);
  }
  if (!draws.length) return null;
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(0.025 * draws.length)]!, draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))]!];
}

const conf = (rows: Row[], which: "ungated" | "gated") =>
  confusion(rows.map((r) => ({ truth: r.truth, predicted: r[which] })));

export type Interval = [number, number] | null;
export type Metric = { value: number | null; ci95: Interval };
export type ConditionReport = Confusion & { precision: Metric; recall: Metric; false_escalation_rate: Metric };

function report(rows: Row[], which: "ungated" | "gated", resamples: number): ConditionReport {
  const c = conf(rows, which);
  const boot = (f: (c: Confusion) => number | null): Metric => ({
    value: f(c),
    ci95: clusterBootstrap(rows, (s) => f(conf(s, which)), { resamples }),
  });
  return {
    ...c,
    precision: boot(precision),
    recall: boot(recall),
    false_escalation_rate: boot(falseEscalationRate),
  };
}

export type ProposerReport = {
  proposer: string;
  describe: string;
  ungated: ConditionReport;
  gated: ConditionReport;
  /** Gated minus ungated false-escalation rate; negative means the gate removes false escalations. */
  false_escalation_change: Metric;
  by_language: Record<string, { documents: number; ungated_fer: number | null; gated_fer: number | null; ungated_recall: number | null; gated_recall: number | null }>;
};

export function evaluate(data: Dataset, resamples = 10000): {
  events: number;
  documents: number;
  severe_events: number;
  proposers: ProposerReport[];
} {
  const truth = new Map(data.events.map((e) => [e.qid, isSevereTruth(e.alert)]));
  const proposers = PROPOSERS.map((p): ProposerReport => {
    const rows: Row[] = data.documents.map((d) => ({
      qid: d.qid,
      truth: truth.get(d.qid)!,
      ungated: ungated(d, p),
      gated: gated(d, p),
    }));
    const fer = (s: Row[], which: "ungated" | "gated") => falseEscalationRate(conf(s, which));
    const diff = (s: Row[]) => {
      const a = fer(s, "gated");
      const b = fer(s, "ungated");
      return a === null || b === null ? null : a - b;
    };
    const langs = [...new Set(data.documents.map((d) => d.lang))].sort();
    const by_language: ProposerReport["by_language"] = {};
    for (const lang of langs) {
      const ids = new Set(data.documents.filter((d) => d.lang === lang).map((d) => d.id));
      const sub = rows.filter((_, i) => ids.has(data.documents[i]!.id));
      by_language[lang] = {
        documents: sub.length,
        ungated_fer: fer(sub, "ungated"),
        gated_fer: fer(sub, "gated"),
        ungated_recall: recall(conf(sub, "ungated")),
        gated_recall: recall(conf(sub, "gated")),
      };
    }
    return {
      proposer: p.name,
      describe: p.describe,
      ungated: report(rows, "ungated", resamples),
      gated: report(rows, "gated", resamples),
      false_escalation_change: { value: diff(rows), ci95: clusterBootstrap(rows, diff, { resamples }) },
      by_language,
    };
  });
  return {
    events: data.events.length,
    documents: data.documents.length,
    severe_events: data.events.filter((e) => isSevereTruth(e.alert)).length,
    proposers,
  };
}
