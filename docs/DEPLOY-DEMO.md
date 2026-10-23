# Public demo deployment

The public demo is a read-only copy of World Watch that anyone can open without a token. A scheduled GitHub Actions workflow collects the structured hazard sources, builds the incident projection and briefs with the real server code in memory, and publishes static JSON files beside a public build of the client on GitHub Pages. Nothing in it can write, sign in or call a model.

Nothing is deployed yet. The workflow is inert until the owner runs the commands below.

## What runs

Every ten minutes, at 7, 17, 27, 37, 47 and 57 past the hour, `.github/workflows/public-demo.yml` does this on a standard GitHub-hosted runner:

1. `npm run build:public` builds the client with `vite build --mode public` into `dist-public/`. Asset paths are relative, so the same build works under `/world-watch/` or a custom domain. The owner-only interface is removed at compile time, not hidden: the bundle has no sign-in form, live event stream, camera, export, correction, merge, split, retry, watch area, replay or sound code. `tests/public-demo.test.ts` checks the built bundle for those endpoints.
2. `npm run snapshot:public` runs `scripts/public-snapshot.ts`, which calls `buildPublicSnapshot` in `src/public/snapshot.ts`. It creates a throwaway in-memory database with every migration in `deploy/migrations`, runs the collector adapters against the live sources, and reads the results back through the server's own `/api/snapshot` in the same process. Rights checks, admission, impact mapping and the GDACS current-listing reconciliation are therefore the API's, not a copy. The briefs come from `structuredBrief`, one per time window the client offers.
3. The workflow uploads `dist-public/` as a Pages artifact and deploys it.

The client reads `data/manifest.json` (revalidated at most every 30 seconds) and, for each new generation, `data/incidents.json`, `data/brief.json` and `data/geospatial.json`. With the thermal layer on, it reads tiles out of `data/thermal.pmtiles` with HTTP range requests: about 23 kB of header and directories, then each tile in view. GitHub's Pages host is listed by Protomaps as serving range requests for PMTiles; a server that ignores `Range` sends the whole file once, and the client then reads tiles from memory. Search, filters, the time window and "Map area" run in the browser with the same predicates as the API (`src/shared/view.ts`).

| File | Ceiling | Measured 23 Oct 2026 (raw, gzip) |
| --- | --- | --- |
| `manifest.json` | 64 KiB | 2.9 kB, 1.4 kB |
| `incidents.json` | 4 MiB | 1.23 MB, about 85 kB (199 incidents, 139 of them ECCC warnings in English and French) |
| `brief.json` | 256 KiB | 27 kB, 5 kB |
| `geospatial.json` | 3 MiB | Mapping areas and counts only: 1.7 kB, 0.7 kB gzip with the 22 to 23 October FIRMS files and no mapping areas (it was 1.69 MB with a 2,000-detection sample and 19 areas) |
| `thermal.pmtiles` | 24 MiB | 4.58 MB for the 218,308 detections of 22 to 23 October, 12,360 gzip-compressed tiles, built in about 1 s of CPU |

A file over its ceiling fails the run, and the last deployment stays live. So does a run in which no source answers. When some sources fail, the run publishes the rest and keeps a failed source's records from the previous snapshot for up to an hour, which is what the private app does when its collector stops. The manifest records each source's status, its last successful read, how many records were kept, its coverage status and its measured latency, and each satellite sensor's coverage status. Latency counts only records that are new or changed since the previous run, because every run starts from an empty database and its first read is backlog. The satellite catalogue is reused while it is under 55 minutes old and healthy, so NASA FIRMS and Copernicus are read about once an hour rather than every run. Their files change about hourly.

Local snapshot runs took 17 to 60 seconds before GDACS got its own 90-second read limit; GDACS failed in three of nine of those runs on 23 October 2026. With that limit a run can take up to about two minutes when GDACS is slow.

## Feeds

Each run also writes static Atom and GeoJSON feeds under `data/feeds/`, one pair per area, hazard and impact combination in `src/shared/feeds.ts`: 11 areas (the world and ten regions, one of them across the 180° line), all hazards or one of eight, and any, significant-or-higher or severe-or-higher impact. The bounding box and both filters are the path, for example `data/feeds/-180,-90,180,90/earthquake/significant.atom`, and `data/feeds/index.json` lists all 297 pairs. The page links the world feed for significant impact or higher for feed-reader discovery, and "Source health" has a picker for the rest.

A feed holds the 100 situations that changed most recently, one entry each, built from the records whose sources permit redistribution: today USGS, EMSC, NWS, ECCC and EASA, not GDACS. A situation fused with a GDACS record still appears through its other records, and the GDACS record adds nothing to the entry, not even its alert level; a situation with only GDACS records doesn't appear. A USGS quake and its EMSC solution are one entry, listing both records in `incident_ids` and both sources. The entry ID is one of its records' incident IDs, and it stays with the record it was first keyed to while that record remains in the situation, so a new lead or a newly fused source updates the entry instead of starting another. Each record's `updated` time is when its `alert-material-v1` projection last changed, and an entry takes the latest of its records. Both are carried between runs in `feed_state` in `incidents.json`, so a rerun over unchanged sources writes byte-identical feeds and a reworded headline changes nothing, while a moved epicentre, a cancellation or a newly fused source updates the entry. Cancelled, retracted and corrected records are titled as corrections. Each feed names every redistributable source's attribution, and each entry its own sources and links. A feed file over 512 KiB fails the run. With the test fixtures the 595 files come to 2.78 MB, most of them near-empty regional combinations; EASA's bulletin text, repeated in every feed that covers its countries, more than doubled the total, and the largest file is 108 kB.

## Sources and rights

The demo publishes only enabled sources whose role is `structured_natural_hazard` or `structured_aviation_advisory`, whose registry rights allow access, storage and display, and that have no unresolved permission. Today those are USGS, EMSC, GDACS, NWS, ECCC and EASA. Every record carries its source's attribution and licence basis, the detail panel shows them, and the banner's "Sources and credits" button lists them all. NASA FIRMS and Copernicus EMS carry their credits and licence links in the satellite panel, and the map credits OpenStreetMap, OpenFreeMap and Natural Earth. NASA GIBS imagery and the Copernicus Data Space scene list are in the demo too. The viewer's browser requests them only when asked, and both carry their credits ([terms](sources.md#satellite-imagery-context)).

The registry keeps display and redistribution separate, and [sources.md](sources.md) uses `redistribute: false` to mean "not offered in exports". GDACS is the case that matters. The European Commission notice grants CC BY 4.0, but the records name third-party inputs, and GDACS says its alerts are not for decision making without confirmation. The demo shows GDACS records, because display is permitted, and leaves them out of its feeds, its only download. That is still a judgement, because the static JSON that carries the display is world-readable, so anyone can copy it. CC BY 4.0 allows that with attribution, which each record carries, and the third-party inputs are only named, not included. If you read `redistribute: false` more strictly, drop GDACS from `PUBLIC_SOURCES` in `src/public/snapshot.ts`.

EMSC sets `redistribute: true`. Its [terms](https://www.seismicportal.eu/terms.html) license data downloaded from its services under CC BY 4.0, commercial use included, and each record carries the credit they ask for. The same terms keep the database itself under copyright and need written permission to mirror it or bulk-copy it in whole or in substantial part. The demo publishes one day of M4.5+ events, 19 and 27 records on the two days checked, which World Watch reads as well short of that.

EASA sets `redistribute: true`. Its [copyright notice](https://www.easa.europa.eu/en/copyright-disclaimer) authorises reproduction with the source acknowledged, which each record carries, and the bulletin text is kept unchanged.

Four source families the private app displays stay out of the public demo, whatever their display permission, because their role isn't on the allowlist or a permission is unresolved:

- RIPEstat routing drops. RIPEstat's terms forbid redistributing its data, and permission to show the RIPE NCC logo, which RIS reuse requires, hasn't been granted yet.
- AWC volcanic ash SIGMETs. Nearly all are issued by other countries' meteorological watch offices and relayed by AWC, and the NWS disclaimer leaves reuse of such third-party information to each provider. Only SIGMETs from US offices are public domain.
- ADSB.lol emergency squawks. The data is ODbL 1.0, so a public copy needs the ODbL notice and has to be offered as a derivative database under the same licence, and ADSB.lol asks production users to contact it first. Neither has been done.
- GDELT news signals. GDELT's own terms allow redistribution with a citation, but what a signal shows is publisher material: article headlines and links, counted by GDELT's machine geocoding. The registry sets `redistribute: false` because publisher rights in those headlines aren't settled, and unlike GDACS, whose records are its own CC BY 4.0 content, GDELT can't license them. A world-readable file of headlines would be a bulk copy of that publisher text. Two practical reasons point the same way. A signal is ranked against 12 hours of earlier GDELT files, and a run that starts from an empty database reads only the newest two, so every signal would say "No baseline yet". And reading the newest two files of both streams is about 10 to 40 MB a run, several gigabytes a day at this schedule. The public build drops the News signals filter, layer and panel, and its briefs carry no news statements. Including GDELT would need a decision on publisher headlines (or a headline-free signal that shows counts and place only) and a baseline kept between runs.

The public build also drops the controls for linking and separating records. Records the fusion rule links still appear as one situation in the feed, on the map and in the brief, because the client groups them from the links each record carries.

## Deploy

First merge `r3/public-demo` into `main`. Scheduled workflows only run from the default branch. Then run these two commands. They need `gh` signed in as an account that administers `fortunexbt/world-watch`.

```sh
gh api --method POST repos/fortunexbt/world-watch/pages -f build_type=workflow
gh variable set WW_PUBLIC_DEMO --repo fortunexbt/world-watch --body on && gh workflow run public-demo.yml --repo fortunexbt/world-watch --ref main
```

The first turns on GitHub Pages with GitHub Actions as its source. On 23 October 2026 the repository had no Pages site, so `POST` is right; if one exists by then, use `--method PUT` instead. The second switches the workflow on and starts the first run without waiting for the schedule. The site appears at `https://fortunexbt.github.io/world-watch/` once the run finishes, after about three minutes.

What gets created:

- a GitHub Pages site for the repository
- the `github-pages` deployment environment, which the first deployment creates
- the repository variable `WW_PUBLIC_DEMO`
- workflow runs, 144 a day

No secrets, no Cloudflare or Vercel resources and no new accounts. Until `WW_PUBLIC_DEMO` is `on`, each scheduled run skips its only job and costs nothing, but it still appears in the Actions list.

## Cost

Zero. GitHub's billing page says "GitHub Actions usage is free for self-hosted runners and for public repositories that use standard GitHub-hosted runners", and GitHub Free includes "GitHub Pages in public repositories". The repository is public and the workflow uses `ubuntu-latest`. If the repository becomes private, both stop being free, and the workflow should be switched off first.

## Limits and terms

Checked on 23 October 2026. GitHub's docs pages show no revision date.

| Item | Source | What it says | How the demo fits |
| --- | --- | --- | --- |
| Schedule interval | [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) | "The shortest interval you can run scheduled workflows is once every 5 minutes." | Every 10 minutes. |
| Schedule delays | Same page | "The `schedule` event can be delayed during periods of high loads … High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped." | Runs avoid the top of the hour. Freshness is best effort, see below. |
| Inactivity | Same page | "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." | Deployments don't commit, so push something, or re-enable the workflow, at least every 60 days. |
| Job time | [Actions limits](https://docs.github.com/en/actions/reference/limits) | Job execution time 6 hours; 20 concurrent jobs on Free. | Runs should take 2 to 4 minutes, including `npm ci`; the job times out at 10. |
| Billing | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) | Free for public repositories on standard runners. | About 13,000 runner-minutes a month, all free. |
| Acceptable use | [Terms for Additional Products, Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions) (effective 27 Aug 2026) | Actions should not be used for "any other activity unrelated to the production, testing, deployment, or publication of the software project associated with the repository", nor for a burden "disproportionate to the benefits provided to users (for example, don't use Actions as a content delivery network or as part of a serverless application …)". The same section says "You may only access and use GitHub Actions to develop and test your application(s)." | See the reading below. |
| Pages size and bandwidth | [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) | Sites "may be no larger than 1 GB"; "soft bandwidth limit of 100 GB per month"; deployments time out after 10 minutes. | The site is about 10 MB, half of it the thermal archive. Real detections cost about 21 bytes each in the archive, so the FIRMS download caps (about 860,000 detections) keep it near 18 MB at most; scattered synthetic detections cost about 80 bytes each. A first visit transfers roughly 1 MB compressed from Pages, mostly the app and map code, so 100 GB is on the order of 100,000 first visits a month. |
| Pages builds | Same page | "soft limit of 10 builds per hour. This limit does not apply if you build and publish your site with a custom GitHub Actions workflow." | Six deployments an hour, through a custom workflow. |
| Pages use | Same page and the Pages terms | Not for "your online business, e-commerce site, or any other website that is primarily directed at either facilitating commercial transactions or providing commercial software as a service"; Pages is "primarily … a showcase for personal and organizational projects". | A non-commercial showcase of this repository. |

Reading of the Actions terms: the workflow builds and publishes this repository's own demo from its own code, which is "deployment, or publication of the software project", it is non-commercial, and each run is a few minutes. GitHub's own Flat Data action ([githubocto/flat](https://github.com/githubocto/flat), archived) was built for exactly this pattern of scheduled public-data fetches. Against that, a ten-minute schedule kept up indefinitely mainly to refresh data sits close to the "serverless application" example, and the "develop and test" sentence, read literally, is narrower. Treat it as defensible rather than certain. If GitHub objects, lengthen the schedule or switch the workflow off; enforcement starts with stopping jobs.

## Freshness

Data reaches the page about 3 to 13 minutes after the sources publish it when the schedule keeps time: up to 10 minutes waiting for the next run, about 1 minute to run, and about 1 to 2 minutes to deploy. That meets the 15-minute target in normal operation, but GitHub doesn't promise it, because scheduled runs can be delayed or dropped under load. The status pill shows the snapshot's age and turns amber after 30 minutes. FIRMS and Copernicus refresh about hourly by design, and the satellite panel shows when they were checked.

## Other hosts considered

- Cloudflare Workers Free. A Cron Trigger gets 10 ms of CPU ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), updated 12 Oct 2026: "CPU time per Cron Trigger | 10 ms"). Parsing the three FIRMS files alone takes about 0.3 s of CPU each, and the first gazetteer lookup about 460 ms ([verification.md](verification.md)), so the pipeline can't run there. Static assets are free and unlimited ([billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), updated 23 Apr 2026), so Workers or Pages Direct Upload would be a fine host, but they would still need Actions to schedule the build, plus an API token secret. R2 (10 GB-month, 1 million Class A operations a month) and KV (1,000 writes a day on Free) add nothing a static deploy needs.
- Vercel Hobby. "Hobby accounts are limited to cron jobs that run once per day" ([cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), updated 15 Jul 2026), deployments are capped at 100 a day ([limits](https://vercel.com/docs/limits), updated 16 Sep 2026), Hobby is "restricted to non-commercial personal use only", and "Scrapers" are on its never-fair-use list ([fair use](https://vercel.com/docs/limits/fair-use-guidelines), updated 14 Sep 2026). It can't meet a 15-minute refresh within its terms.

## Adding free inference later

The demo runs no model. Narrative sources would need batch triage before they could publish, and `src/public/snapshot.ts` marks where it goes: after collection, claim jobs through `/api/worker/claim` and submit through `/api/worker/complete` in the same in-memory server, so the host's result validation, evidence, place and severity checks decide what publishes. The OpenAI-compatible backend and the vetted provider table are being built on `r3/inference` (`src/worker`, `docs/inference-providers.md`). Provider keys would be repository secrets passed to the snapshot step as environment variables, and the workflow notes the spot.

Platform options checked on 23 October 2026:

- Cloudflare Workers AI is on the Free plan: "Our free allocation allows anyone to use a total of 10,000 Neurons per day at no charge" ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), updated 20 Oct 2026). Calling it from Actions needs a Cloudflare account ID and API token as secrets. Requests fail once the daily allocation is spent, so triage has to tolerate gaps.
- GitHub Models is gone: "As of July 30, 2026, GitHub Models has been fully retired" ([changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/)).

Each narrative source also needs its registry rights to allow model processing and display before it can join `PUBLIC_SOURCES`.

## Try it locally

```sh
npm run build:public
npm run snapshot:public -- --out dist-public/data
python3 -m http.server 4336 --bind 127.0.0.1 --directory dist-public
```

Open `http://127.0.0.1:4336/`. The snapshot step reads the live public sources once, about 40 MB in all, most of it the three FIRMS files. Add `--previous <site URL>` to build on a published snapshot the way the workflow does.

## Tear down

```sh
gh variable delete WW_PUBLIC_DEMO --repo fortunexbt/world-watch
gh api --method DELETE repos/fortunexbt/world-watch/pages
```

The first stops new runs at once. The second unpublishes the site. To remove the rest, delete the `github-pages` environment (`gh api --method DELETE repos/fortunexbt/world-watch/environments/github-pages`) and `.github/workflows/public-demo.yml`.

## Limitations

- Each run starts from an empty database, so the demo shows what the sources list now, plus up to an hour of a failed source's last records. It has no history, replay or revision trail, and the 7- and 30-day windows show nearly the same records as the day window. Links keep their window, filters, search, map position, scope and layers; a link carrying a time from the owner app opens the latest snapshot and says so.
- Thermal tiles are rebuilt with the catalogue, about hourly, and the panel counts detections worldwide rather than in the view.
- Cameras, exports, watch areas, alerts, Web Push, notes, corrections, record linking, news signals and the analysis worker are not in the demo.
- A feed entry's ID and update time come from the previous snapshot. A run that can't read it, such as the first deployment, dates every entry to that run, so readers see each entry once more. An entry whose keyed record leaves the snapshot while its fused partner stays continues under the partner's ID, as a new entry.
- Only USGS, EMSC, GDACS and EASA cover the world; NWS and ECCC cover the United States and Canada.
- Nothing here has run on GitHub. The workflow passes `actionlint`, and its build and snapshot steps were run locally against the live sources, but the Pages deployment itself is unverified until the first run.
