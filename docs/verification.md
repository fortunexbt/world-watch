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

## Unproven

- Representative discovery recall, relevance precision, false merges, severity calibration and multilingual robustness.
- Reliable event geography or city-level coverage beyond selected sources.
- End-to-end latency percentiles, week-long operation, restart/restore drills and account-wide capacity.
- Always-on inference when the initial Mac is asleep or unavailable.
- Physical-iPhone fidelity, assistive-technology usability and large-volume map performance.
- Broad audiovisual verification, reliable automated crowd counts or cross-domain causal inference.
- External notification delivery, full-corpus spatial search and durable multi-operator workflows.

Release gates and evaluation tasks are in [TODO.md](../TODO.md). Record future results with fixture/live/access-blocked labels, source dates, workload, configuration and limitations. Store private originals outside Git and publish only reviewed, redistribution-safe summaries. Do not replace a failed live integration with a fixture while retaining its live label.
