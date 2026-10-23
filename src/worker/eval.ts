import { analyze, analysisKey } from "./adapter.js";
import { configuredBackend } from "./chat.js";
import { invalidRule } from "./worker.js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../shared/contracts.js";
import { expected, fixtures } from "./eval-fixtures.js";
function agreement(r: AnalysisResult, index: number) {
  const e = expected[index],
    places = r.claims.flatMap((c) => c.places);
  return {
    relevance: r.relevant === e.relevant && !!r.claims.length === e.relevant,
    location:
      [...new Set(places.map((p) => p.country))].sort().join() ===
        e.countries.join() &&
      e.places.every((re) => places.some((p) => re.test(p.name))),
    severity: r.claims.every((c) => e.impacts.includes(c.impact)),
  };
}
const size = Math.min(
  fixtures.length,
  Math.max(1, Number(process.argv[2] || 1)),
);
const spool = path.join(process.env.EW_WORKER_STATE || "work/worker", "spool");
const backend = await configuredBackend(spool);
const start = Date.now();
const r = await analyze(fixtures.slice(0, size), {
  timeout: Number(process.env.EW_EVAL_TIMEOUT_MS || 180000),
  effort: process.env.EW_EVAL_EFFORT || "low",
  backend,
});
const total_ms = Date.now() - start;
const reportResults = new Map(
  [...r.accepted.values()].map((value) => [value.report_id, value]),
);
const runs = [
  ...new Map(
    [...r.runs.values()].map((run) => [run.invocation_id, run]),
  ).values(),
];
const perFixture = fixtures.slice(0, size).map((input, index) => {
  const result = reportResults.get(input.report_id);
  return result
    ? { report_id: input.report_id, ...agreement(result, index) }
    : {
        report_id: input.report_id,
        rejected: invalidRule(
          r.invalid.get(analysisKey(input)) ?? "missing_result",
        ),
      };
});
const accepted = perFixture.filter((f) => !("rejected" in f)) as {
  relevance: boolean;
  location: boolean;
  severity: boolean;
}[];
const rate = (n: number) => `${n}/${accepted.length}`;
const outputTokens = runs.reduce(
  (n, run: any) =>
    n + (run.usage?.completion_tokens ?? run.usage?.output_tokens ?? 0),
  0,
);
const checks = {
  peaceful_visible:
    reportResults
      .get("fixture-0")
      ?.claims.some(
        (c) =>
          c.activity === "planned_demonstration" &&
          c.violence_mentioned === "no",
      ) ?? null,
  historical_not_today:
    reportResults
      .get("fixture-2")
      ?.claims.every((c) => c.temporal_status === "historical") ?? null,
  no_invented_video_activity: reportResults.has("fixture-2")
    ? reportResults.get("fixture-2")?.claims.length === 0
    : null,
  correction_excludes_negated_city:
    reportResults
      .get("fixture-3")
      ?.claims.every(
        (c) => !c.places.some((p) => p.name.toLowerCase() === "madrid"),
      ) ?? null,
  correction_relationship:
    reportResults
      .get("fixture-3")
      ?.claims.some((c) =>
        c.relationships.some((x) => x.type === "corrects"),
      ) ?? null,
  two_cities_separate: reportResults.has("fixture-4")
    ? reportResults.get("fixture-4")?.claims.length === 2
    : null,
  no_tools: runs.every((run) => run.tool_attempts === 0),
};
const results = {
  summary: {
    schema_valid: `${r.accepted.size}/${size}`,
    rejections: perFixture.flatMap((f) =>
      "rejected" in f ? [f.rejected] : [],
    ),
    relevance_agreement: rate(accepted.filter((f) => f.relevance).length),
    location_agreement: rate(accepted.filter((f) => f.location).length),
    severity_agreement: rate(accepted.filter((f) => f.severity).length),
    reports_per_minute: Number(((size * 60000) / total_ms).toFixed(2)),
    output_tokens_per_second: Number(
      ((outputTokens * 1000) / total_ms).toFixed(2),
    ),
  },
  checks,
  per_fixture: perFixture,
  sample_size: size,
  total_ms,
  runs,
  accepted: [...r.accepted.values()],
  invalid: [...r.invalid],
  isolated: true,
  production_accuracy_claim: false,
};
const label = runs[0]?.provider
  ? runs[0].provider + "-" + runs[0].requested_model
  : process.env.EW_EVAL_EFFORT || "low";
await mkdir("work/worker", { recursive: true });
await writeFile(
  "work/worker/evaluation-" +
    size +
    "-" +
    label.replace(/[^\w.-]+/g, "_") +
    ".json",
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
