# Verification boundaries

The application is paused. This public repository distributes source and synthetic test fixtures, not a live incident corpus or private execution receipts.

## Reproducible checks

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run build
npm run audit:public
```

Tests cover source parsing/admission, authentication boundaries, leases and stale submissions, permissions, deletion, deterministic geography, brief contracts, replay, and selected browser interactions. Some browser tests replace the map or APIs with fixtures; passing them cannot establish a real usable map or an interesting newsfeed. Browser tests start disposable local Vite processes and should leave none running.

`npm run test:browser` is a separate operator harness against a deliberately started local app. It is not part of the safe offline check and must not be aimed at private data without authorization. Its outputs belong in ignored execution storage.

## Previous real execution

Before pause, source ingestion, local Luna analysis, private publication, public imagery and satellite retrieval were exercised on selected integrations. Those observations were narrow and time-bound. Private receipts and source copies were removed from the published repository; they cannot serve as independently reproducible public proof.

The user found the product unhelpful in ordinary testing: a clunky feed with little useful variety and no convincing intelligence value. Parser and transport success do not refute that finding.

## PR 0 repairs

PR 0 of [the core plan](plans/GLOBAL_OSINT_CORE_PLAN.md) changed three behaviours and nothing else. All results are offline fixtures. No collector, model or deployment ran.

- Severity. `src/shared/severity.ts` replaces the rule that let a bare violence flag or an empty official instruction promote a claim to severe or critical. High impact now needs an affirmed consequence phrase quoted from the claim's own cited evidence, or a matching, cited official directive. Critical also needs catastrophic or mass-casualty wording. Nonviolent fire and displacement can reach high impact when their consequences are stated. Covered by `tests/severity.test.ts`. The checks are lexical, so they catch negation and modality in the same clause but do not establish semantic entailment.
- Correction routing. A correction or retraction now reaches every rule that previously received an eligible notice, even after the location leaves the watch area or filters, quiet hours, cooldown or the rule's enabled flag change. A correction written while completing a rejected worker result is now held back by the same acceptance guard. Covered by `tests/server-alerts.test.ts` and `tests/pr0-alert-integration.test.ts`.
- Material change. Alerts compare a versioned projection (`alert-material-v1`) of the last notice delivered to that rule, not the immediately preceding revision. Location, timing, instructions, severity, evidence status, claims and cancellation count. Headline and summary wording do not.

`docs/verification/pr0-query-profile.json` profiles the new delivery lookup in synthetic SQLite (`python3 scripts/profile-alert-queries.py`). VM steps are not D1 billed rows. Lookups for rules notified long ago or never notified still scan the incident's delivery ledger, so a composite index is a candidate follow-up.

## Unproven

- Representative discovery recall, relevance precision, false merges, severity calibration and multilingual robustness.
- Reliable event geography or city-level coverage beyond selected sources.
- End-to-end latency percentiles, week-long operation, restart/restore drills and account-wide capacity.
- Always-on inference when the initial Mac is asleep or unavailable.
- Physical-iPhone fidelity, assistive-technology usability and large-volume map performance.
- Broad audiovisual verification, reliable automated crowd counts or cross-domain causal inference.
- External notification delivery, full-corpus spatial search and durable multi-operator workflows.

Release gates and evaluation tasks are in [TODO.md](../TODO.md). Record future results with fixture/live/access-blocked labels, source dates, workload, configuration and limitations. Store private originals outside Git and publish only reviewed, redistribution-safe summaries. Do not replace a failed live integration with a fixture while retaining its live label.
