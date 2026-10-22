import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clusterBootstrap,
  confusion,
  eager,
  evaluate,
  falseEscalationRate,
  gated,
  lexicalAlarm,
  mulberry32,
  precision,
  recall,
  ungated,
  wilson,
  type Dataset,
  type EvalDocument,
} from "../scripts/severity-eval/lib.js";

const doc = (id: string, qid: string, text: string, lang = "en"): EvalDocument => ({ id, qid, lang, text });

const affirmed = doc("a", "Q1", "The earthquake struck at dawn. It killed 40 people and destroyed 300 homes.");
const negated = doc("b", "Q2", "The earthquake struck at dawn. No homes were destroyed.");
const hypothetical = doc("c", "Q3", "Officials warned that the aftershocks could cause deaths.");

test("eager proposes severe and quotes the opening sentence", () => {
  assert.deepEqual(eager.propose(affirmed), { impact: "severe", quote: "The earthquake struck at dawn." });
});

test("lexical alarm quotes the first consequence sentence and stays minor without one", () => {
  assert.equal(lexicalAlarm.propose(affirmed).quote, "It killed 40 people and destroyed 300 homes.");
  assert.equal(lexicalAlarm.propose(doc("d", "Q4", "A magnitude 5 earthquake struck.")).impact, "minor");
});

test("the gate keeps an affirmed consequence and rejects the opening-sentence quote", () => {
  assert.equal(gated(affirmed, lexicalAlarm), true);
  assert.equal(gated(affirmed, eager), false);
  assert.equal(ungated(affirmed, eager), true);
});

test("the gate rejects negated and hypothetical consequences that the keyword proposer accepts", () => {
  for (const d of [negated, hypothetical]) {
    assert.equal(ungated(d, lexicalAlarm), true, d.id);
    assert.equal(gated(d, lexicalAlarm), false, d.id);
  }
});

test("confusion and rates", () => {
  const c = confusion([
    { truth: true, predicted: true },
    { truth: true, predicted: false },
    { truth: false, predicted: true },
    { truth: false, predicted: false },
    { truth: false, predicted: false },
  ]);
  assert.deepEqual(c, { tp: 1, fp: 1, fn: 1, tn: 2 });
  assert.equal(precision(c), 0.5);
  assert.equal(recall(c), 0.5);
  assert.equal(falseEscalationRate(c), 1 / 3);
  assert.equal(precision({ tp: 0, fp: 0, fn: 1, tn: 1 }), null);
});

test("wilson interval matches a known value", () => {
  const [lo, hi] = wilson(5, 10)!;
  assert.ok(Math.abs(lo - 0.2366) < 1e-3 && Math.abs(hi - 0.7634) < 1e-3);
  assert.equal(wilson(0, 0), null);
});

test("bootstrap is deterministic and resamples whole events", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    qid: `Q${i >> 2}`,
    truth: i % 2 === 0,
    ungated: true,
    gated: i % 4 === 0,
  }));
  const stat = (s: typeof rows) => falseEscalationRate(confusion(s.map((r) => ({ truth: r.truth, predicted: r.gated }))));
  assert.deepEqual(clusterBootstrap(rows, stat, { resamples: 200 }), clusterBootstrap(rows, stat, { resamples: 200 }));
  const rand = mulberry32(1);
  assert.equal(rand(), mulberry32(1)());
});

test("evaluate reports a lower gated false-escalation rate on a small dataset", () => {
  const data: Dataset = {
    events: [
      { qid: "Q1", alert: "red" },
      { qid: "Q2", alert: "green" },
      { qid: "Q3", alert: "green" },
    ],
    documents: [affirmed, negated, hypothetical],
  };
  const report = evaluate(data, 50);
  assert.equal(report.severe_events, 1);
  const lexical = report.proposers.find((p) => p.proposer === "lexical-alarm")!;
  assert.equal(lexical.ungated.false_escalation_rate.value, 1);
  assert.equal(lexical.gated.false_escalation_rate.value, 0);
  assert.equal(lexical.gated.recall.value, 1);
});

test("the committed results reproduce from the committed dataset", async () => {
  const read = async (name: string) => JSON.parse(await readFile(new URL(`../eval/severity/${name}`, import.meta.url), "utf8"));
  const dataset = await read("dataset.json");
  assert.ok(dataset.licences && dataset.retrieved);
  const counts = (report: ReturnType<typeof evaluate>) =>
    report.proposers.map(({ proposer, ungated, gated }) => ({
      proposer,
      ungated: [ungated.tp, ungated.fp, ungated.fn, ungated.tn],
      gated: [gated.tp, gated.fp, gated.fn, gated.tn],
    }));
  assert.deepEqual(counts(evaluate(dataset, 20)), counts(await read("results.json")));
});
