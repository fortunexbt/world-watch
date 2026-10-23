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

Start-up was first timed in a fresh Node 24.18.0 process per run that imports the built module, whose top-level code then parsed the gazetteer and built its name index. Over 15 runs the median process CPU time was 952 ms (900 to 1,081 ms). `src/server/geo.ts` bundled the same way took a median 880 ms on its own, so the gazetteer accounts for most of start-up. Wall-clock medians (1.8 s for the Worker, 3.0 s for the gazetteer module) are not usable, because the load average was 28 to 34 on 10 cores during the runs. `process.cpuUsage` counts every thread, so it overstates main-thread work, and a workerd isolate may differ. Nothing was measured on Sites or Cloudflare.

Limits: the [Cloudflare Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) (marked "Last updated Oct 12, 2026", fetched 2026-10-22) sets a 64 MiB uncompressed Worker size on Free and Paid, with no compressed limit, and requires a Worker to parse and execute its global scope within 1 second. The Sites target's own limits are not recorded in this repository and were not established. Against the Cloudflare figures, size had headroom but start-up was close to the limit. The same page allows 10 ms of CPU per HTTP request on Free and 5 minutes on Paid, with a 30 second default.

The gazetteer index is now built on the first place lookup instead of in global scope, with the same rows, keys and match order. The packaged Worker is 10,605,546 bytes raw and 4,061,940 gzip. The old and new Worker were timed alternately in the same session, 15 runs each, with the load average between 59 and 79 on 10 cores, so the absolute figures are inflated and only the comparison holds:

| Measure (median of 15, Node 24.18.0)                      | Index in global scope  | Index on first lookup |
| --------------------------------------------------------- | ---------------------- | --------------------- |
| Worker import, process CPU                                | 655.9 ms               | 125.2 ms              |
| Worker import, main-thread CPU (`process.threadCpuUsage`) | 578.3 ms               | 124.3 ms              |
| First `resolveClaimLocations` call, main-thread CPU       | Lookup only, not timed | 462.2 ms (424 to 497) |
| Second call, main-thread CPU                              | Not timed              | 0.5 ms                |

The lookup was timed on `src/server/geo.ts` bundled with the same options, in a fresh process per run, with the load average between 51 and 59. Building the index in a warm script under a load average of about 14 took 230 to 310 ms of CPU, and alternative structures (no per-row `Set`, single cities stored without an array) were within that noise, so the cost is the 290,000 normalised keys rather than the container. The first lookup in each isolate therefore needs a few hundred milliseconds of request CPU. That fits Cloudflare's Paid default of 30 seconds but not Free's 10 ms, and the Sites per-request budget is unknown. Fitting 10 ms would need an index generated at build time, such as a sorted key table searched in place; it would add several megabytes to the bundle and has to reproduce `toLocaleLowerCase` exactly.

## Worldwide-scale performance (2026-10-23)

Local measurements only. Nothing ran on Cloudflare or Sites, no hosted D1 was queried and no real event data was used. Other agents shared the 10-core machine, so every sample records the load average; it ranged from about 4 to 240 over the day. Row counts, map source updates and React render counts do not depend on load and are the primary evidence. Wall-clock and CPU figures are comparable only between runs at similar load, which the tables say. The machine restarted mid-session and lost the first set of runs; everything below was re-measured afterwards. These figures were measured on a6f2e17, before the branch was rebased onto the fusion, news and public-demo work; the rebase moved fusion's earthquake candidate read from the dropped latitude index to `incidents_cell`.

### Harnesses

`npm run perf:load` (`scripts/load-harness.ts`) builds a throwaway local D1 store, the Miniflare engine `wrangler dev` uses, applies the committed migrations and seeds it through the real `ingest` path with `scripts/synthetic.ts`. The trimmed USGS, GDACS, NWS and ECCC fixtures are moved, re-timed and renumbered, so stored views have production shapes. It then calls the Worker's `fetch` handler in-process against that store. Rows read and written come from D1's own query metadata, handler CPU is the Node thread's CPU time, and FIRMS and Copernicus are answered from synthetic files. It never opens a port or reaches the network, and it deletes the store on exit.

```sh
npm run perf:load -- --incidents=100000 --save-store=/path/to/store --out=load.json
npm run perf:load -- --store=/path/to/store --runs=5 --out=load.json   # reuse a seeded store
```

Options: `--incidents`, `--revised` (share revised one to four times, 0.25), `--rules` (20), `--days` (30), `--thermal` (200,000 detections), `--runs`, `--streams` (10), `--burst` (60 records) and `--seed`. A reused store gets only the migrations it lacks, timed, so one store seeded on an older commit measures both sides of a schema change.

`npm run perf:client` (`scripts/client-perf.ts`) builds the client into a temporary directory, serves it on an ephemeral port and answers every API call in Playwright with synthetic data. It records frame intervals, long tasks, long animation frames, CDP task, script, layout and style time, React commits and component renders (through the DevTools hook) and GeoJSON loads sent to MapLibre's workers.

```sh
npm run perf:client -- --markers=1000,5000 --browser=chromium,webkit --runs=3 --out=client.json
```

### Reference workload and scene

The reference store holds 100,000 incidents over 30 days with 162,218 revisions and observations, 75,640 outbox rows (seven days), 1,244,360 alert deliveries from 20 rules, 103 sources and 200,000 FIRMS-shaped thermal detections. Weights: contiguous US (NWS) 31%, Canada (ECCC) 13%, Japan 10%, Indonesia 9%, Europe 8%, South Asia 6%, Fiji and Tonga across the antimeridian 5%, Chile 5%, the Aleutians across the antimeridian 4% and a sparse worldwide background 10%. Views average 4,496 bytes. The store is 4.7 GB on disk. It contains structured incidents only, no model-analysed ones.

The reference client scene is a 1440 by 900 viewport in headless Chromium 156 on the real GPU (ANGLE Metal, Apple M4) and in Playwright WebKit 27.2, with the 1,000 incidents the snapshot API caps at, 2,000 thermal points once the layer is on and the bundled Natural Earth boundaries (external tiles and glyphs are blocked). It measures load, three mouse drags, six wheel steps, the drags again with thermal points, and a burst of 100 SSE arrivals, each followed by the client's compact detail read, with the feed showing. 5,000 incidents is a stress case beyond the API cap. This is desktop Chromium, not a phone; no claim here covers iPhone smoothness.

### Budgets

| Budget                                                                          | Before                         | After                                    |
| ------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| Windowed regional snapshot, D1 rows read on the reference store, at most 10,000 | 8,581 to 59,818                | 805 to 8,595                             |
| Issuer ingest of three records, rows read, at most 1,000                        | 100,535                        | 508                                      |
| Plan gate: p95 accepted structured record to projection under 60 s              | Met locally, 2.8 s             | Met locally, 1.4 s                       |
| Plan gate: p95 warm viewport response under 500 ms                              | Not met                        | Not met for 1,000-incident views (below) |
| Plan gate: p95 frame time under 33 ms on the reference scene                    | 16.8 ms Chromium, 18 ms WebKit | 16.7 ms Chromium, 18 ms WebKit           |
| Map source data sent by a pan                                                   | 8 loads                        | 0 (`tests/client-render-budget.test.ts`) |
| Feed rows rendered by one SSE arrival                                           | every row                      | 1 (same test)                            |

`tests/geography.test.ts` asserts that a windowed bbox read seeks `incidents_cell` on both of its columns, and `tests/search-index.test.ts` that a revision replaces its one search row.

### Server results

D1 rows read are identical in every run. Latency medians are from five runs; the "before" run had a load average of 27 to 36 and the "after" run 7 to 11, so their latencies are not a fair comparison, but in an earlier pair at similar load (24 to 69 before, 53 to 56 after) 10 of 60 "before" regional reads failed inside local D1 and none failed after.

| Snapshot (`include_incoming=0`)      | Rows read before | after  | Median ms before (load) | after (load) | Bytes     |
| ------------------------------------ | ---------------- | ------ | ----------------------- | ------------ | --------- |
| World, 168 h                         | 1,211            | 1,211  | 144 (36)                | 103 (8)      | 4,650,536 |
| Europe, 24 h                         | 58,314           | 5,482  | 5,405 (33)              | 173 (8)      | 3,852,716 |
| Europe, 168 h                        | 59,818           | 8,595  | 1,631 (31)              | 410 (8)      | 3,908,396 |
| Contiguous US, 24 h                  | 57,400           | 6,878  | 2,001 (29)              | 605 (8)      | 5,802,872 |
| Japan, 24 h                          | 43,339           | 1,771  | 339 (29)                | 116 (8)      | 1,138,231 |
| Fiji across the dateline, 24 h       | 8,581            | 1,103  | 580 (29)                | 100 (8)      | 644,219   |
| Fiji across the dateline, all time   | 13,100           | 10,329 | 158 (29)                | 291 (7)      | 3,342,105 |
| Aleutians across the dateline, 168 h | 24,877           | 2,441  | 330 (29)                | 199 (8)      | 2,848,293 |
| Sahara (quiet), 168 h                | 11,399           | 805    | 432 (27)                | 34 (8)       | 220,460   |
| Search "earthquake", 168 h           | 15,320           | 15,320 | 825 (27)                | 422 (8)      | 1,866,904 |

A three-record issuer POST read 100,535 rows before and 508 after; a 60-record burst with a third of it revisions read 2.01 million rows before and 8,558 to 11,322 after, writing 3,420 either way. In three alternating ingest-only runs at a load of 5 to 20, the median POST took 300 ms before and 205 ms after and record-to-projection p95 was 713 and 651 ms; local D1 scans its in-process index fast enough that the scan shows in rows read, which D1 bills, far more than in latency. Delivery to ten live streams added up to one 1 s poll. Applying the cell and search-index migrations (now 0010 and 0011) to the 100,000-incident store took 33 to 114 s locally; on D1 the rebuild reads and writes every live incident once.

The SSE stream used to select whole outbox payloads, which average 2,320 bytes on the reference store because they carry incident views, and now selects about 130 bytes of event fields per row. In three alternating runs at a load of 4 to 16, catching up 200 outbox rows (100 incident events) took a median 70 µs of handler CPU per incident event per stream before and 52 µs after with one stream in its own isolate, and 52 and 30 µs with ten. Rows read stayed 203 per stream.

Uncached structured briefs read 104 rows and used 10 to 30 ms of handler CPU. A geospatial request parsing all three synthetic FIRMS files cold used 476 to 718 ms of CPU per isolate and ten minutes; warm world requests used 30 to 60 ms and returned 2,000 features in 1.66 MB.

### Client results

Chromium at 1,000 incidents, medians of three alternating runs at a load average of 8 to 21:

| Scene                         | Measure                                            | Before                    | After                   |
| ----------------------------- | -------------------------------------------------- | ------------------------- | ----------------------- |
| Load                          | First feed row, ready                              | 314 ms, 1,573 ms          | 299 ms, 1,530 ms        |
| Pan                           | Map source loads, script, LoAF blocking, p99 frame | 8, 195 ms, 14 ms, 33.3 ms | 0, 93 ms, 0 ms, 16.8 ms |
| Pan with 2,000 thermal points | Map source loads, script                           | 24, 117 ms                | 2, 95 ms                |
| 100 SSE arrivals              | Task, script, wall                                 | 4,828 ms, 3,465 ms, 5.4 s | 591 ms, 268 ms, 1.7 s   |
| 100 SSE arrivals              | Component renders, elements reconciled, map loads  | 105,468, 1,341,504, 432   | 6,979, 40,127, 40       |

WebKit at 1,000 incidents: the burst's component renders fell from 61,006 to 4,803 and its wall time from 3.7 to 1.8 s, and pan p99 from 29 to 18 ms. At 5,000 incidents (Chromium, load 60 to 200, two or three runs; some runs timed out clicking the layer control) pan script time fell from 1,237 to 184 ms and LoAF blocking from 1,045 to 0 ms, and the burst's task time from 14.2 to 1.1 s. Frame p95 stayed at one display frame in Chromium in every scene before and after: the costs were long frames around each settled view and SSE arrival, not steady panning. The end-of-run JS heap varied from 40 to 79 MB between runs with no consistent direction. An attempt at 20,000 incidents closed the page in the baseline build before the restart; its log was lost and it is not in the tables.

### List views and SSE views (after the rebase)

These ran on the rebased branch, which includes fusion, news signals and the public demo. The rebase renumbered the cell and search-index migrations to 0010 and 0011 (drizzle 0006 and 0007) and moved fusion's earthquake candidate read to `incidents_cell`: it seeks the cells within reach and window keys from the origin-time window on, and `tests/fusion.test.ts` asserts that plan. Each comparison alternates the commit before a change with the commit after it on the same store, at a load average of 6 to 9.

The client now asks for `view=list` snapshots. A list view keeps every field the feed, map, filters and situation grouping read, the quake excerpt the marker size comes from and the per-report rights flags, and drops summaries, other evidence text and rights wording, which the detail read of a selected incident already supplies (`tests/snapshot-list.test.ts`). Without `view=list` the snapshot is unchanged, so the public snapshot builder still publishes full views. On a 100,000-incident store reseeded on the rebased branch (two rounds each):

| Snapshot            | Bytes before | after     | Gzip before | after   | Handler CPU before | after |
| ------------------- | ------------ | --------- | ----------- | ------- | ------------------ | ----- |
| World, 168 h        | 4,684,811    | 1,751,374 | 553,345     | 236,737 | 31 ms              | 26 ms |
| Europe, 24 h        | 3,970,346    | 1,383,532 | 268,992     | 196,883 | 30 ms              | 22 ms |
| Contiguous US, 24 h | 5,825,258    | 1,573,915 | 550,717     | 217,007 | 46 ms              | 29 ms |
| Japan, 24 h         | 1,225,126    | 820,768   | 91,250      | 83,051  | 15 ms              | 15 ms |

USGS-heavy views shrink least because the quake excerpt stays. In-process latency did not change measurably: local D1 time dominates it and varied more between rounds (Europe 24 h median 128 to 393 ms) than between commits. The savings are transfer and the client's JSON parse, which the in-process harness does not see. Every median was under 500 ms at this load, but single runs reached 0.8 s (contiguous US) and 1.6 s (search), so the 500 ms p95 gate is still not established, and not at all on Cloudflare.

Created, updated and escalated SSE events now carry the incident's list view, checked against current source rights and the default monitoring filter once per tick for all streams in an isolate; an event whose view the compact detail read would refuse stays bare, and the client reads it back as before (`tests/sse-views.test.ts`, `tests/client-render-budget.test.ts`). Ten clients, each in its own isolate, catching up 98 incident events on a 20,000-incident store, three rounds:

| Measure                                                   | Before | After  |
| --------------------------------------------------------- | ------ | ------ |
| Detail reads                                              | 980    | 0      |
| D1 queries                                                | 2,001  | 40     |
| D1 rows read                                              | 4,001  | 3,100  |
| Handler CPU                                               | 746 ms | 69 ms  |
| Handler CPU per event per stream, stream only, one stream | 54 µs  | 111 µs |

A stream that never reads details costs more per event, for parsing and sending the view, and each isolate reads the 103 source records once per tick that has incident events.

### Issuer footprints

Measured on 23 October 2026 from one live read of each source, saved and replayed offline through the adapters and the in-process API: 35 NWS warnings, 295 ECCC warnings, CHAMPI-26's GDACS geometry and the ShakeMap for us6000u43g (M7.0 Nagqu). Positions are coordinate pairs; tolerances are as stated on each copy.

| Geometry                       | Issuer                         | Detail copy                                 | Display copy                               |
| ------------------------------ | ------------------------------ | ------------------------------------------- | ------------------------------------------ |
| 295 ECCC warning regions       | 52,760 positions, at most 1,298 | 131,383 bytes, at most 173 positions, 0.33 km | 60,296 bytes, at most 28 positions, 2.79 km |
| 35 NWS warning polygons        | 381 positions, at most 21       | 8,624 bytes, 0.33 km                        | 7,690 bytes, 2.79 km                       |
| CHAMPI-26 wind buffers         | 483,875-byte response, 1,480 positions in the three buffers | 9,095 bytes, 532 positions, 0.58 km | 3,729 bytes, 235 positions, 4.79 km |
| us6000u43g MMI contours        | 44,596 bytes, 1,797 positions in 75 lines | 8,496 bytes, 489 positions, 4.08 km | 4,025 bytes, 235 positions, 16.79 km |

The same 355 incidents (332 with a footprint) through the in-process API:

| Measure                          | Without footprints | With footprints     |
| -------------------------------- | ------------------ | ------------------- |
| Full snapshot views              | 2,442,248 bytes (115,739 gzip) | 2,733,082 (169,090 gzip) |
| `view=list` snapshot             | 504,227 (71,743 gzip) | 595,916 (86,785 gzip) |
| Public demo views (display copies only) | 2,442,248   | 2,572,164           |
| Search index text                | 2,427,671          | 2,427,671           |
| Largest three-record ingest body | 14,336             | 17,904              |

Coordinates compress poorly, so gzip grows more than raw bytes. On the synthetic 1,000-incident world store (430 NWS and ECCC records carrying the trimmed fixture polygons), list views grew from 1,617,678 to 1,716,755 bytes (6.1%, 230 bytes per footprint) and from 222,398 to 242,639 gzip; `tests/footprints.test.ts` fails if a list footprint carries a detail copy, exceeds 240 positions, or the 400-incident list grows by 10% or more.

`npm run perf:client -- --markers=1000 --runs=1 --browser=chromium`, three runs each, alternating the base commit and this branch at a load average of 26 to 44: pan p95 and p99 frames stayed at 16.7 to 16.8 ms with no map source loads; load-to-ready medians were 2,684 ms before and 2,729 ms after; the 100-arrival SSE burst's main-thread script medians were 1,050 and 1,058 ms. The burst sent 161, 141 and 122 GeoJSON loads to the map worker after, against 98, 96 and 69 before, because each arrival with a footprint re-sends the footprint source as well as the incident source. The footprint source now sends the whole set only on its first load and patches it afterwards with MapLibre's `updateData`, keyed by short numeric feature ids. With 1,000 synthetic list views (430 footprints) on screen and 50 SSE arrivals carrying NWS and ECCC footprints, in Chromium: before, 50 footprint loads posted 8,602,583 bytes to the map worker, about 172 kB per arrival; after, 50 patches posted 31,560 bytes. The first load went from 169,816 to 173,560 bytes for the ids. `tests/footprint-map.test.ts` asserts that a pan sends neither source, that selecting an incident patches the footprint source once with its detail copy, and that footprints arriving by SSE are patched in one each and drawn.

### Every thermal detection as vector tiles

The thermal layer no longer samples. The server parses the three FIRMS files as before, sorts every detection once per refresh by its zoom 9 tile (`src/server/thermal-tiles.ts`), and encodes Mapbox Vector Tiles from that order: below zoom 6 one point per occupied cell (64 by 64 cells a tile) at the cell's mean position with its exact count, from zoom 6 to 9 every detection, grouped into one multipoint per sensor, acquisition minute and confidence. MapLibre overzooms zoom 9 tiles, whose 4,096 units resolve about 19 m at the equator, a twentieth of a VIIRS pixel. The owner app reads `/api/thermal/<refresh>/{z}/{x}/{y}`, owner-only, encoded on first request and kept for the refresh; a tile under its own refresh's name is immutable. The public snapshot writes every tile into one PMTiles archive, `data/thermal.pmtiles`, and the public client reads it with range requests through a small reader (`src/client/thermal-tiles.ts`), falling back to the whole file when a server ignores `Range`. A click picks the nearest detection within 12 px from the tile itself, so its sensor, acquisition time and confidence need no other read. `tests/thermal-tiles.test.ts` decodes tiles with MapLibre's own decoder and checks that every zoom's counts sum to the total, the antimeridian, the PMTiles layout, leaf directories and the 24 MiB ceiling; `tests/client-thermal.test.ts` checks layer switching and click provenance on the real map.

Tooling considered: tippecanoe (BSD-2) is a C++ binary outside npm that the Actions runner would have to install, and its defaults drop or merge points at low zooms, which breaks exact counts; `geojson-vt` and `vt-pbf` (ISC, MIT, already under MapLibre) need a GeoJSON copy of every detection; the `pmtiles` package (BSD-3, 4.5.0) only reads archives and adds about 20 kB plus `fflate` to the client. The index and encoder, archive writer and range reader here are about 680 lines with no new dependency. The `pmtiles` 4.5.0 reader, run outside the repository, read all 12,360 tiles of the real archive below, and its tile IDs matched ours for 26,000 random tiles. Bundle growth: owner client +2.1 kB (+0.9 kB gzip), public client +4.9 kB (+2.3 kB gzip, the reader is only in the public build), Worker +3.6 kB minified.

Real day: the FIRMS 24-hour files read at 13:55 UTC on 23 October 2026, limited to the 24 hours before 12:05 UTC, held 218,308 detections. Archive build, three runs at a load average of 28 to 31: index 81 to 119 ms, tiles and archive 753 to 979 ms wall (1.0 to 1.2 s CPU) after a 1.1 to 1.7 s parse. The archive is 4,583,584 bytes with 12,360 tiles; the largest tile is 44 kB before gzip (zoom 6), a world view's zoom 0 tile 9 kB. The synthetic 200,000-detection reference day is scattered more evenly and makes a 16.3 MB archive with 50,832 tiles, still inside the ceiling.

Worker handler CPU from `npm run perf:load` on the synthetic 200,000 detections (Node, in process, five runs, load average 20 to 24, baseline at `1a58114` alternated with this change):

| Request | Before | After |
| --- | --- | --- |
| Geospatial world, cold (parses FIRMS) | 833 ms | 630 ms |
| Geospatial world, warm | 66 ms, 1,662,612 bytes, 2,000 detections | 0.9 ms, 1,713 bytes, counts only |
| First tile of a refresh (indexed it at the time) | | 110 ms (93 to 161) |
| Any other tile, first request | | median 0.1 to 3.9 ms by zoom, at most 9.2 ms |
| Same tile again | | at most 1.9 ms |

Client, `--use-angle=metal` headless Chromium on an Apple M4, 1440 by 900, the real day's files re-timed for each run, no incidents, external tiles blocked, three alternating runs per build. Each run turns the layer on at the world view, pans three times, zooms with 17 wheel steps to zoom 6.6 over Botswana and Zambia, pans there and zooms out. Bytes are what the local server sent gzip-compressed. Load averages were 25 to 38 at 1x CPU and 8 to 19 at 4x. One baseline run at 1x lost its page midway and is left out, so that cell has two runs.

| Measure (medians) | Before: 2,000 sampled | After: all 218,308 |
| --- | --- | --- |
| Layer on to settled map, 1x CPU | 637 ms, 46.6 kB | 753 ms (641 to 1,047), 12.5 kB |
| Layer on, main-thread task time, 4x CPU | 215 ms | 180 ms |
| World pan, bytes | 93 kB (two re-reads of the sample) | 1.4 kB |
| Zoom to 6.6, bytes and requests | 42 kB, 1 | 186 kB, 55 tiles |
| Regional pan, bytes | 127 kB | 37 kB |
| Whole session, bytes sent (raw) | 356 kB (13.3 MB) | 268 kB (0.56 MB) |
| Frame p95 and p99 in every gesture, 1x and 4x CPU | 16.7 to 16.8 ms | 16.7 to 16.8 ms |
| Frames over 33 ms, LoAF blocking | 0 to 1, 0 ms | 0, 0 ms |
| Zoom and regional pan, map worker busy time (traces) | 1,275 ms (884 to 1,322) | 762 ms (631 to 769) |
| Same, renderer main and GPU main busy time | 2,245 and 1,608 ms | 2,022 and 1,526 ms |

The public build, served with the real archive by a local server that honours `Range` (three identical runs), read 35,708 bytes in 5 range requests to show the world view (the first 16 KiB of the file, one leaf directory and the tiles) and 232,378 bytes in 55 requests for the same zoom to 6.6 over Zambia and the Democratic Republic of the Congo. Tiles inside the archive are already gzip-compressed, so these are transfer sizes.

Frame pacing held at one display frame in both builds at 1x and 4x CPU, so the frames don't separate them; the map worker did less work with tiles, because the sample was re-read and re-tiled on every settled view. The reference client scene (`npm run perf:client`, 1,000 incidents and all 200,000 synthetic detections) panned at p99 16.8 ms with no long animation frames in a single run at load 10. This is desktop Chromium; no claim here covers iPhone smoothness.

Two follow-ups, each alternated with the commit before it:

- The catalogue load now builds the tile index, so the first tile request after a refresh only encodes its tile. In process with the 200,000 synthetic detections, nine runs each at a load average of 10 to 17, the first zoom 0 tile fell from a median of 104 ms (57 to 124) of handler CPU to 15 ms (7 to 22), and the cold catalogue request rose from 648 ms (421 to 778) to 755 ms (589 to 952). Encoding the world tile still aggregates every detection.
- MapLibre asks for a tile once for each world copy on screen, all at once, and neither it nor the browser cache merges those requests. Owner and public tiles now load through one `thermal` protocol (`src/client/thermal-tiles.ts`) that shares one read between them. On the real-day client scene above, re-downloaded on 23 October 2026 (three alternating runs, load average 10 to 23), turning the layer on sent 2 requests (4.7 kB) instead of 4 (12.6 kB), the session 80 to 83 instead of 84 to 87 (288 to 291 kB instead of 305 to 308 kB), and the largest single request's handler CPU fell from 74 to 108 ms to 11 to 14 ms with the index change. Frame p99 stayed 16.7 to 16.8 ms. The shared reads are not aborted when a tile leaves the view.

### Remaining costs, largest first

- Snapshot handler CPU. A list-view world snapshot still parses 1,000 full views from D1 (26 to 30 ms of handler CPU), above Workers Free's 10 ms. Trimming in SQL, or storing a list projection beside each view, would cut the parse.
- Search reads every match before ranking (14,876 rows for "earthquake"), and all-time area views read every row in their cells (10,337 for Fiji).
- Each three-record ingest still reads about 500 rows, mostly the alert delivery ledger, and the store grows to 4.7 GB at 100,000 incidents, 1.24 million rows of it alert deliveries from 20 rules, which needs checking against D1's per-database size limit.
- The first geospatial request in an isolate parses about 30 MB of FIRMS text and indexes every detection, 0.6 to 0.95 s of CPU on the synthetic day.
- No phone was measured. iPhone claims need Safari Web Inspector timelines on a physical device with the same scene.

## Unproven

- Representative discovery recall, relevance precision, false merges, severity calibration and multilingual robustness.
- Reliable event geography or city-level coverage beyond selected sources.
- End-to-end latency percentiles, week-long operation, restart/restore drills and account-wide capacity.
- Always-on inference when the initial Mac is asleep or unavailable.
- Physical-iPhone fidelity, assistive-technology usability, and map and API performance on real devices and on Cloudflare.
- Broad audiovisual verification, reliable automated crowd counts or cross-domain causal inference.
- External notification delivery, full-corpus spatial search and durable multi-operator workflows.

Release gates and evaluation tasks are in [TODO.md](../TODO.md). Record future results with fixture/live/access-blocked labels, source dates, workload, configuration and limitations. Store private originals outside Git and publish only reviewed, redistribution-safe summaries. Do not replace a failed live integration with a fixture while retaining its live label.
