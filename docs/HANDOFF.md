# Handoff

## Status and intended product

The project is paused at the owner's request. Do not resume sources, inference, cloud schedules or local services as part of reading this handoff. `docs/paused.md` describes the operational pause; repository code alone does not prove the current state of any external service.

The original specification asks for broad European public-source awareness with durable collection, exact `gpt-6-luna` analysis through supported Codex authentication, and a simple interface: one flat world map centred on Europe, one compact feed and one reusable detail panel. It also asks for source rights, corrections, sleep/quota recovery, useful search and private areas. These remain the product requirements, not a claim that all have been completed.

Later user direction narrowed acquisition: useful public gatherings, unrest, access restrictions, evacuation and displacement matter more than source counts. Passenger train circulation and institutional announcements must not dominate the system. The user also requested a rolling five-minute headline of at most30 words, with important reports pinned **below the headline**. These priority pins open details; they do not imply supported geographic coordinates. The user found the sidebar and overall usefulness inadequate; the next team should revisit the information hierarchy instead of assuming cosmetic polish is enough.

## Product acceptance failed in testing

The user explicitly rejected the testing experience as boring, clunky and overwhelmingly focused on wildfire/notices rather than useful public-activity intelligence. This is an observed product failure, not merely a missing production certification. More infrastructure, markers or cosmetic polish will not resolve it. Start with `docs/VISION.md` and the P/C/U tasks in `TODO.md`: define the questions worth answering, choose a small high-value lawful source portfolio, distinguish original reporting from syndication, and test relevance/novelty/uncertainty against real user tasks. Source silence is a coverage fact; it is not negative evidence that nothing happened.

## What exists

The repository contains a React/MapLibre client, a Worker-style API with D1 storage, a separate scheduled collector, a local Codex worker and append-only SQL migrations. The prior deployment moved from a standalone Cloudflare database to private Sites-managed D1; the separate Cloudflare process became a small authenticated collector trigger. This differs from the specification's preferred PostgreSQL/PostGIS architecture. No supported usage-billed inference fallback or verified always-on inference deployment is implemented.

The durable path includes source records, observation revisions, analysis jobs, leases/fencing, local completed-result spools, validated claims, incident revisions and a transactional outbox. Exact-content/native-episode reuse exists; general semantic situation bundling is incomplete. Model input is compacted separately from stored provenance. Effective served model/tier can remain unknown even when the requested configuration is exact.

Selected source adapters exist for Norway public police messages, Sweden's police API, MIT strike metadata, BBK official warnings, Catalunya public fire records, Zwaailicht publisher-generated fire clusters, Demos public assembly metadata, IDMC Ukraine displacement updates and narrowly filtered Paris traffic/public-event records. Availability is not complete national coverage. Some adapters were exercised against real public payloads and through the hosted pipeline during implementation; the paused repository does not establish present upstream availability.

Public camera metadata/snapshots and selected provider-declared HLS video are contextual. FIRMS thermal detections and Copernicus mapping areas are separate geospatial context. They are not automatic incident verification, crowd measurement or camera AI. See the source and geospatial modules for exact adapter limits.

## Repository map

| Area               | Main files                                                                       | Responsibility                                                                         |
| ------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Client composition | `src/client/App.tsx`, `src/client/style.css`, `src/client/locale.ts`             | Feed/detail navigation, filters, reading state, localized controls                     |
| Map                | `src/client/Map.tsx`                                                             | Flat map, supported locations, context layers, interaction/cues                        |
| Rolling headline   | `src/client/RollingBrief.tsx`, `src/shared/brief.ts`                             | Dated headline, citations, priority report links, strict output contract               |
| API                | `src/server/index.ts`                                                            | Authentication/scopes, ingestion, jobs, snapshots, SSE, search, corrections, retention |
| Brief jobs         | `src/server/brief.ts`                                                            | Closed processing windows, input selection, durable leases, publication fences         |
| Collector          | `src/collector/index.ts`, `registry.ts`, `fetch.ts`, `parsers.ts`, `adapters/`   | Approved retrieval, parsing, admission, checkpoints and source health                  |
| Coverage           | `src/shared/coverage.ts`, `src/client/Coverage.tsx`                              | Source and sensor status, issuer and publication latency, coverage view and legend     |
| Remote trigger     | `src/collector/remote.ts`, `deploy/collector.wrangler.jsonc`                     | Small paused scheduled entry, no database binding                                      |
| Inference          | `src/worker/adapter.ts`, `analyst.ts`, `wire.ts`, `worker.ts`, `brief.ts`        | Supported Codex transport, extraction, result validation and spooling                  |
| Worker lifecycle   | `src/worker/cli.ts`, `supervisor.ts`, `budget.ts`                                | Local supervision, locks, daily accounting and recovery                                |
| Incident logic     | `src/server/bundling.ts`, `geo.ts`, `alerts.ts`, `src/shared/temporal.ts`        | Conservative reuse, source-supported geography, clocks and alert decisions             |
| Media/context      | `src/server/cameras.ts`, `geospatial.ts`, `src/shared/media.ts`, `geospatial.ts` | Allowlisted public context, caches, validity and attribution                           |
| Storage            | `deploy/migrations/`, `drizzle/`                                                 | Local/legacy and Sites migration sequences; applied files are immutable                |
| Packaging          | `scripts/build-sites.mjs`, `src/sites-entry.ts`, `Dockerfile`, `compose.yaml`    | Build/deployment alternatives; operator configuration must be private                  |
| Tests              | `tests/`                                                                         | Isolated API, source, model-contract, browser-transport and geometry fixtures          |

## Known failures and limits

1. **Observed live: redundant older brief inference.** After a newer headline had published, the supervisor generated an older bootstrap period. It consumed another model call without replacing the current headline. The latest implementation still needs a regression-tested rule that creates bootstrap work only when no normal work is ready/in flight, retires older work after newer publication, and atomically rejects older completion. Start with `TODO.md` tasks B01–B10. Do not erase the consumed-call ledger.
2. **Observed operational failure: database read exhaustion.** The original Free D1 deployment exhausted its daily read allowance. Indexed retention, counters, caching, compact SSE deltas and hidden-tab suspension were added. Their presence is not proof of sustainable24/7 use; establish a new measured request/rows budget before resuming.
3. **Observed source-quality failure: pipeline dominated by notices.** SNCF circulation and institutional feeds generated large amounts of irrelevant work. Defaults were changed, but every new view, brief, repair and replay path needs tests against reintroducing disabled/context sources.
4. **Known acquisition limit: Demos corrections.** The adapter polls the latest20 created records; the API does not offer an updated sort. Older amendments/deletions and bursts can be missed. Publisher crawling is approximately three-hourly, not live attendance observation. Factual metadata is CC BY-SA4.0; upstream articles and private contacts are excluded.
5. **Known context limit: IDMC.** The Ukraine source supplies daily provisional displacement flows, capped to recent rows. Estimates can overlap; neither summing them nor averaging multi-place coordinates is valid. It is not live individual movement.
6. **Known validation boundary: model semantics.** Schema/citation validity does not establish correct dates, severity, location, independence or event relevance. Earlier real-payload tests exposed time-containment and unsupported-impact errors. Host temporal rules and targeted evaluations reduce risk but do not establish calibrated accuracy.
7. **Coverage and access blockers.** Broad local news/public-social coverage remains incomplete. TfL registration, publisher-specific AI/display rights, platform approvals and paid/research access must be resolved individually. Do not substitute scraping, account rotation or a decorative source entry.
8. **Infrastructure alternatives remain unverified.** Docker execution and a separately authenticated always-on analysis host were not demonstrated end to end. Sites-managed storage has finite account capacity; a new host does not create an unlimited budget.

Brief revision fences, source-rights/deletion purges and explicit obsolete-window handling have isolated regression tests. They still need deployment verification after the redundant-work defect is fixed. Already published text may retain an explicitly dated processing window; it must not be presented as an event that happened in that window.

## Reproduce and verify safely

Use `AGENTS.md` for offline checks. `npm run check`, `npm test` and `npm run build` do not authorize live model/source activity. The cleanup suite reports 201 tests: 200 passed and one explicit host-sandbox integration test skipped. That opt-in test requires an authorized Codex host. Rerun the suite for the exact revision being handed over; fixture success does not establish product usefulness.

For the redundant-brief defect, extend `tests/server-brief.test.ts` with an isolated database containing both a recent normal closed window and an older eligible bootstrap window. Claim and complete the normal window, then claim again: the second claim must be null, no bootstrap must have been created unnecessarily, and older existing work must have an explicit obsolete/superseded reason. Also insert a newer completed window between an older lease's preflight and commit; the atomic update must reject it. Run the equivalent `tests/worker-brief.test.ts` transport scenario and assert zero second model calls. Do not recreate this bug against a live model merely to prove it exists.

Important test gaps include extended sleep/restart recovery, multi-worker races, retained-data deletion across backups/spools, sustained rows/day, source edits/deletes after finite feed windows, broad multilingual semantic recall, small-device/Safari use and realistic burst/correction behavior. See `TODO.md` for acceptance criteria and sequencing.

## Restart gate and team ownership

Resume only after an explicit owner instruction. First agree on product scope, budget and accountable operator; fix the brief defect; review current source permissions/retention; verify storage limits and the pause controls; run offline tests; then approve one bounded real source→queue→Luna→incident→UI test. Keep fixtures out of production and mark genuine access blockers.

Suggested work lanes are product/design, acquisition/rights, inference/quality, storage/runtime, client/map and independent verification. Assign files before parallel work. `src/server/index.ts`, `src/client/App.tsx`, shared contracts and migration journals need one integrating owner per change. Public GitHub hosting is not permission to run services or a substitute for choosing a code licence. Do not restore account-specific hosting manifests or private test histories from another checkout.
