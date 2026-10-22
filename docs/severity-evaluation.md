# Severity gate evaluation

The idea under test: a model may not raise a claim to severe or critical unless the claim quotes an affirmed consequence from its own cited evidence, and the host, not the model, decides. `validateSeverity` in `src/shared/severity.ts` implements it. This page says what was measured, what the numbers show and what they don't.

## Headline

Run against 1,908 real encyclopedia excerpts about 264 past earthquakes in 23 languages, the gate does what it is built to do and nothing more.

| Proposer | Condition | False-escalation rate | Precision | Recall |
| --- | --- | --- | --- | --- |
| eager (always proposes severe) | ungated | 100.0% [100.0, 100.0] | 47.6% [38.8, 55.7] | 100.0% [100.0, 100.0] |
| eager | gated | 1.8% [0.8, 3.0] | 48.6% [24.2, 71.9] | 1.9% [0.8, 3.2] |
| lexical-alarm (keyword, no polarity) | ungated | 56.8% [51.3, 62.1] | 51.1% [41.5, 59.9] | 65.3% [59.7, 70.2] |
| lexical-alarm | gated | 52.9% [47.3, 58.4] | 51.8% [42.2, 60.7] | 62.6% [56.7, 67.7] |

Intervals are 95% percentile bootstrap intervals that resample whole events, 10,000 resamples, seed 20261022.

What follows from it:

1. The gate removes unsupported escalation. A proposer that escalates every document drops from a 100% to a 1.8% false-escalation rate [0.8, 3.0], because its quote (the opening sentence) rarely holds an affirmed consequence.
2. The gate does not make severity correct. Against the keyword proposer it lowers the false-escalation rate by only 3.9 points [2.6, 5.3], from 56.8% to 52.9%. Precision hardly moves (51.1% to 51.8%, intervals overlap almost entirely). Gating is not a measurable precision gain over the ungated keyword baseline on this data.
3. The residual "false" escalations are mostly a label mismatch rather than gate failures. USGS PAGER alert levels are modelled loss estimates. A Wikipedia lead about a green or yellow event often states real deaths or injuries, which the gate rightly accepts as affirmed consequences. Spot checks of the gated false positives I read showed this pattern; I did not code them all. Text and PAGER measure different things, so a gate that is correct on the text still scores a false escalation.

So the claim the data supports is narrow: the gate is a reliable filter for escalations that the evidence doesn't back, and it costs little recall when the proposer quotes the right sentence (62.6% against 65.3% ungated). It is not shown to improve agreement with an external severity ground truth.

## One real gate limitation

The validator has no event attribution. It checks that the quoted sentence is in the cited excerpt and affirmed, not that it describes the event the claim is about. In the dataset, a sentence about an earlier earthquake in the same region (an 1856 quake) passed the gate for a 2021 event. That is a design gap, not a data artefact, and it is the first thing to fix if the gate is to be trusted in production.

## Method

- Unit of analysis: a document (one language edition's lead of one event). A document is severe-truth when its event's PAGER alert is orange or red (76 events). Green and yellow are non-severe (188 events). This gives 908 severe and 1,000 non-severe documents.
- Gate under test: the real `validateSeverity`, called on a constructed claim and job. A claim the gate rejects counts as not escalated, which is what the host publishes.
- Proposers are deterministic stand-ins for a model: `eager` and `lexical-alarm` in `scripts/severity-eval/lib.ts`. No model is called. There are no recorded model outputs in this repository, so there is no measured rate for a real model. A real-model ungated baseline needs recorded outputs for the same documents, run through the same `gated` and `ungated` functions.
- Statistics: Wilson intervals are provided for single proportions in the library; every number in the table uses the clustered bootstrap, because the documents of one event are the same earthquake in different languages and are not independent. The change in false-escalation rate has its own paired bootstrap interval.
- Per-language results are in `eval/severity/results.json`. Counts per language are small, so don't read them as language rankings.

## Data

Everything is in `eval/severity/dataset.json`, retrieved 2026-10-23. Each document records its Wikipedia title, language and revision id, so any text can be checked against its source.

| Data | Source | Licence |
| --- | --- | --- |
| Severity labels | USGS ComCat PAGER `alertlevel` | Public domain |
| Event to article links | Wikidata property P3196 (USGS event id) | CC0 |
| Text | Wikipedia lead extracts, pinned by revision id | CC BY-SA 4.0 |

The excerpts are redistributed under CC BY-SA 4.0 with attribution through the per-document `url` (permanent revision link) and `title`. They are truncated at a sentence end within 900 characters. GDACS (CC BY 4.0) and Wikinews (CC BY 2.5) were considered and not used: GDACS events can't be matched to articles reliably, and Wikinews is sparse in most languages.

## Limits

- Earthquakes only. Floods, storms, fires and conflict are untested.
- Selection bias: only quakes with a Wikipedia article and a USGS PAGER alert are included, so they skew toward notable and damaging events.
- PAGER is modelled loss, not reported harm. This is the main source of disagreement between label and text.
- Wikipedia leads are retrospective summaries, not the live news a deployed model would read.
- The proposers are bounds, not a model. Nothing here measures a model's real false-escalation rate.
- Swahili has no data because no article matched. The gate's coverage for it is untested.
- The gate has no event attribution (see above).
- The hosted deployment is paused (see `docs/paused.md`), so these results are not on a live page and nothing was measured against live traffic.

## Reproduce

```
npm run eval:severity
```

This reads `eval/severity/dataset.json`, makes no network calls and rewrites `eval/severity/results.json` identically. `tests/severity-eval.test.ts` checks the confusion counts against the committed results.

To rebuild the dataset from the public sources (network, slow, USGS rate limits apply):

```
node scripts/severity-eval/build-dataset.mjs
```

A rebuild pulls current Wikipedia revisions, so the dataset and numbers will change.
