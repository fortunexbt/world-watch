import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configuredBackend } from "./chat.js";
import { expected, fixtures } from "./eval-fixtures.js";
import { triageHeadlines, type TriageOutcome } from "./triage.js";

// Usage: tsx src/worker/triage-eval.ts [batch size] [full-extraction evaluation JSON to compare]
type Labelled = {
  id: string;
  title: string;
  relevant: boolean;
  categories: string[];
  country: string | null;
};
const corpus: {
  labelled: Labelled[];
  syndicated: { id: string; of: string; title: string }[];
} = JSON.parse(await readFile("tests/fixtures/triage-headlines.json", "utf8"));
const batchSize = Number(process.argv[2] || 25),
  compare = process.argv[3];
const backend = await configuredBackend(
  path.join(process.env.EW_WORKER_STATE || "work/worker", "spool"),
);
const options = {
  backend,
  batchSize,
  timeout: Number(process.env.EW_EVAL_TIMEOUT_MS || 900000),
};
const url = (id: string) => "https://example.invalid/triage/" + id;
const records = [...corpus.labelled, ...corpus.syndicated].map((r) => ({
  id: r.id,
  title: r.title,
  url: url(r.id),
}));

const start = Date.now();
const outcomes = await triageHeadlines(records, options);
const total_ms = Date.now() - start;
const byId = new Map(outcomes.map((o) => [o.id, o]));
const resolve = (o: TriageOutcome): TriageOutcome =>
  o.status === "duplicate" ? resolve(byId.get(o.duplicate_of)!) : o;
const label = new Map(corpus.labelled.map((l) => [l.id, l]));
for (const s of corpus.syndicated)
  label.set(s.id, { ...label.get(s.of)!, id: s.id });

const count = (list: string[]) =>
  list.reduce<Record<string, number>>(
    (n, k) => ({ ...n, [k]: (n[k] ?? 0) + 1 }),
    {},
  );
function relevance(ids: string[]) {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0,
    undecided = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const o = resolve(byId.get(id)!),
      truth = label.get(id)!.relevant;
    if (o.status === "rejected") {
      undecided++;
      continue;
    }
    const predicted = o.status === "accepted" && o.relevant;
    if (predicted && truth) tp++;
    else if (predicted) fp++;
    else if (truth) fn++;
    else tn++;
    if (predicted !== truth)
      errors.push(`${id} ${predicted ? "false_positive" : "false_negative"}`);
  }
  return {
    tp,
    fp,
    fn,
    tn,
    undecided,
    precision: Number((tp / (tp + fp)).toFixed(3)),
    recall: Number((tp / (tp + fn)).toFixed(3)),
    errors,
  };
}
const accepted = outcomes.filter((o) => o.status === "accepted");
const runs = [
  ...new Map(
    outcomes.flatMap((o) =>
      "run" in o && o.run ? [[o.run.invocation_id, o.run] as const] : [],
    ),
  ).values(),
];
const outputTokens = runs.reduce(
  (n, r: any) =>
    n + (r.usage?.completion_tokens ?? r.usage?.output_tokens ?? 0),
  0,
);
const modelled = outcomes.filter(
  (o) => o.status === "accepted" || o.status === "rejected",
).length;
const relevantHits = corpus.labelled.filter((l) => l.relevant);
const placed = relevantHits.flatMap((l) => {
  const o = resolve(byId.get(l.id)!);
  return o.status === "accepted" && o.relevant ? [{ l, o }] : [];
});

// Lean triage of the extraction fixtures, each excerpt read as a headline.
const fixtureOutcomes = await triageHeadlines(
  fixtures.map((f) => ({
    id: f.report_id,
    title: f.excerpts[0].text,
    url: f.canonical_url,
  })),
  { ...options, batchSize: fixtures.length },
);
const full = compare
  ? new Map(
      (JSON.parse(await readFile(compare, "utf8")).accepted as any[]).map(
        (r) => [r.report_id, r],
      ),
    )
  : null;
const fixtureAgreement = fixtureOutcomes.map((o, i) => {
  const lean = o.status === "accepted" ? o : null,
    extraction = full?.get(o.id);
  return {
    report_id: o.id,
    lean_status: o.status === "rejected" ? o.rule : o.status,
    lean_relevant: lean?.relevant ?? null,
    lean_category: lean?.category ?? null,
    expected_relevant: expected[i].relevant,
    ...(extraction
      ? {
          full_relevant: extraction.relevant,
          full_categories: extraction.claims.map((c: any) => c.activity),
        }
      : {}),
  };
});

const results = {
  summary: {
    model: runs[0]?.actual_model ?? runs[0]?.requested_model ?? null,
    provider: runs[0]?.provider ?? null,
    batch_size: batchSize,
    records: records.length,
    prefilter: count(
      outcomes.map((o) =>
        o.status === "duplicate"
          ? o.kind + "_duplicate"
          : o.status === "filtered"
            ? o.reason
            : "sent_to_model",
      ),
    ),
    model_calls: runs.length,
    rejections: count(
      outcomes.flatMap((o) => (o.status === "rejected" ? [o.rule] : [])),
    ),
    headlines_per_minute: Number(
      ((records.length * 60000) / total_ms).toFixed(1),
    ),
    model_headlines_per_minute: Number(
      ((modelled * 60000) / total_ms).toFixed(1),
    ),
    output_tokens_per_model_headline: Number(
      (outputTokens / modelled).toFixed(1),
    ),
    prompt_tokens: runs.reduce(
      (n, r: any) => n + (r.usage?.prompt_tokens ?? 0),
      0,
    ),
    output_tokens: outputTokens,
    total_ms,
    relevance_unique: relevance(corpus.labelled.map((l) => l.id)),
    relevance_all_records: relevance(records.map((r) => r.id)),
    category_agreement: `${placed.filter(({ l, o }) => o.status === "accepted" && !!o.category && l.categories.includes(o.category)).length}/${placed.length}`,
    country_agreement: `${placed.filter(({ l, o }) => o.status === "accepted" && o.places.some((p) => p.cc === l.country)).length}/${placed.length}`,
    places_grounded: (() => {
      const places = accepted.flatMap((o) =>
        o.status === "accepted" ? o.places : [],
      );
      return `${places.filter((p) => p.grounded).length}/${places.length}`;
    })(),
    review_flags: accepted.filter((o) => o.status === "accepted" && o.review)
      .length,
    fixtures_relevance_vs_expected: `${fixtureAgreement.filter((f) => f.lean_relevant === f.expected_relevant).length}/${fixtures.length}`,
    ...(full
      ? {
          fixtures_relevance_vs_full_extraction: `${fixtureAgreement.filter((f) => f.lean_relevant === f.full_relevant).length}/${fixtures.length}`,
          fixtures_category_in_full_extraction: `${fixtureAgreement.filter((f) => f.lean_category && f.full_categories?.includes(f.lean_category)).length}/${fixtureAgreement.filter((f) => f.full_categories?.length).length}`,
        }
      : {}),
  },
  fixtures: fixtureAgreement,
  outcomes: outcomes.map((o) =>
    "run" in o ? { ...o, run: o.run?.invocation_id } : o,
  ),
  runs,
  isolated: true,
  production_accuracy_claim: false,
};
await mkdir("work/worker", { recursive: true });
await writeFile(
  `work/worker/triage-${batchSize}-${String(results.summary.model).replace(/[^\w.-]+/g, "_")}.json`,
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results.summary, null, 2));
