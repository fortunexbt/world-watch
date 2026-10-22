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

## Worldwide pass checks (2026-10-22)

Local measurements only. Nothing was deployed, no hosted D1 was queried and no Cloudflare or Sites account was used.

### D1 expression indexes and plans (H04)

Wrangler 4.151.3 (Miniflare 5.20261019.1-beta, workerd 1.20261019.1) applied `deploy/migrations/0001` to `0008` to a throwaway `--persist-to` directory through a temporary config, as `scripts/demo.ts` does. It accepted both JSON expression indexes in `0008_incident_geography.sql`. The SQL below is what the snapshot handler emits for `bbox=170,-25,-170,-10` and for `hours=24`, with its parameters inlined as literals, planned with `EXPLAIN QUERY PLAN` through `wrangler d1 execute --local`:

| Query                                      | Local D1 plan                                                                                                  | node:sqlite 3.53.1 plan, bound parameters as in `tests/geography.test.ts` |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Largest radius for the bbox reach          | `SEARCH incidents USING INDEX incidents_radius`                                                                | Same                                                                      |
| Bbox read, `INDEXED BY incidents_latitude` | `SEARCH incidents USING INDEX incidents_latitude (<expr>>? AND <expr><?)`, then `USE TEMP B-TREE FOR ORDER BY` | Same                                                                      |
| Window-only read                           | `SCAN incidents USING INDEX incidents_recent`                                                                  | Same                                                                      |

Neither database had `ANALYZE` statistics. Local D1 runs the SQLite bundled with workerd, so this does not show what hosted D1 accepts or how it plans. That needs an explicitly authorised EXPLAIN against the hosted database.

### Sites Worker bundle and start-up (H05)

The Worker was bundled with the options in `scripts/build-sites.mjs` (ESM, browser platform, es2022, minified, `charset: "utf8"`), embedding the six files of `npm run build` (3,547,998 bytes). The hosting manifest check was skipped, and no artifact was written to `dist/`. Sizes are bytes; gzip is Node zlib at its default level.

| Bundle                                                | Raw                   | Gzip      |
| ----------------------------------------------------- | --------------------- | --------- |
| Sites Worker as packaged, with embedded client assets | 10,605,464 (10.1 MiB) | 4,061,915 |
| Same Worker without embedded assets                   | 5,874,349             | 2,562,866 |

The earlier 5.8 MB and 2.55 MB figures were the Worker without its embedded assets, which add 4,731,141 bytes of base64 JSON. ASCII escaping instead of UTF-8 would make the packaged Worker 14,389,301 bytes.

Start-up was timed in a fresh Node 24.18.0 process per run that imports the built module, whose top-level code parses the gazetteer and builds its name index. Over 15 runs the median process CPU time was 952 ms (900 to 1,081 ms). `src/server/geo.ts` bundled the same way took a median 880 ms on its own, so the gazetteer accounts for most of start-up. Wall-clock medians (1.8 s for the Worker, 3.0 s for the gazetteer module) are not usable, because the load average was 28 to 34 on 10 cores during the runs. `process.cpuUsage` counts every thread, so it overstates main-thread work, and a workerd isolate may differ. Nothing was measured on Sites or Cloudflare.

Limits: the [Cloudflare Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) (marked "Last updated Oct 12, 2026", fetched 2026-10-22) sets a 64 MiB uncompressed Worker size on Free and Paid, with no compressed limit, and requires a Worker to parse and execute its global scope within 1 second. The Sites target's own limits are not recorded in this repository and were not established. Against the Cloudflare figures, size has headroom but start-up is close to the limit; building the gazetteer index lazily or at build time would remove most of it.

## Unproven

- Representative discovery recall, relevance precision, false merges, severity calibration and multilingual robustness.
- Reliable event geography or city-level coverage beyond selected sources.
- End-to-end latency percentiles, week-long operation, restart/restore drills and account-wide capacity.
- Always-on inference when the initial Mac is asleep or unavailable.
- Physical-iPhone fidelity, assistive-technology usability and large-volume map performance.
- Broad audiovisual verification, reliable automated crowd counts or cross-domain causal inference.
- External notification delivery, full-corpus spatial search and durable multi-operator workflows.

Release gates and evaluation tasks are in [TODO.md](../TODO.md). Record future results with fixture/live/access-blocked labels, source dates, workload, configuration and limitations. Store private originals outside Git and publish only reviewed, redistribution-safe summaries. Do not replace a failed live integration with a fixture while retaining its live label.
