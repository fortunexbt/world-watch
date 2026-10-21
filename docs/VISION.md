# World Watch: a useful worldwide OSINT workspace

This is a proposed product direction. It is not a description of the current app. Source documentation was checked on 21 October 2026; new candidates below have not been integrated or tested in the pipeline.

## Worldwide source gate

The new research target is at least 50 useful sources per country before broadening live coverage. For 193 UN member states plus the two observer states, that is 9,750 country-source memberships; territories and other separately monitored areas need explicit treatment. Country assignment must distinguish the publisher’s base from where it reports. One global provider appearing in 195 country packs is still one provider, not 195 independent origins.

A country pack should mix original local reporting with domain-specific authorities and instruments. Fifty URLs, a directory entry or fifty sections of one publisher do not establish that coverage. Some small states may not have fifty independent useful domestic publishers; show those gaps and investigate relevant cross-border coverage rather than manufacturing the count. The source atlas records candidates, access checks, rights and operating integrations separately. Collection remains paused during this work.

## What should make someone keep it open

An analyst opens the map and understands what has changed since their last visit, which developments deserve investigation, and where the platform cannot see well enough to judge. An unfamiliar event becomes understandable in one panel: sequence, geography, direct evidence, contradictions, potential consequences and the next useful check.

The advantage should come from connecting complementary observations earlier and explaining them better. A thousand coloured dots and rewritten headlines do not provide that advantage. The current prototype failed this test: repetitive fire coverage, weak local reporting and a clunky feed produced little reason to return. Its test count does not change that assessment.

Start with a user who needs to investigate developing infrastructure and public events worldwide. Expand geographically and by domain only after that workflow works. "Everything" is an ambition for discovery and extensibility, never a claim of complete observation.

## The screen

Keep one flat world map centred on Europe. Its default view should survive a busy news day without becoming a dashboard of competing widgets.

```text
┌────────────────────────────────────────────────────────────────────┐
│ EUROPE WATCH     What changed · 5 min        Search / command    UTC │
│ A short, cited brief. Age and coverage shown. Important items below.│
├──────────────────────────────────────────────┬─────────────────────┤
│                                              │ CHANGES             │
│                                              │ One event per row   │
│                 WORLD MAP                    │ What changed        │
│                                              │ Why it surfaced     │
│    Observations and uncertainty at scale     │ Evidence / age      │
│    Relevant context when an event opens      │                     │
│                                              │ New updates buffer  │
│                                              │ while reading       │
├──────────────────────────────────────────────┴─────────────────────┤
│ Time scrubber on demand · sources fresh / stale / missing           │
└────────────────────────────────────────────────────────────────────┘
```

Selecting a row opens the existing reusable detail panel and focuses the same event on the map. The panel offers deeper views without adding a second feed or permanent sidebars. On a phone, the feed and detail become successive sheets over the same map. Preserve reading position, selection and map context throughout.

The visual language can be striking without becoming theatrical: precise typography, restrained colour, quiet terrain, crisp event glyphs and a visible time axis. Reserve motion for an actual new material change. No constant pulses, autoplay camera walls or animated danger textures.

### The feed is an editor

Default to material changes since the last visit. Each row answers: what happened, what is new, where, when, what evidence exists, and why this rose above the rest. Collapse an event's ten updates into one row with a change count. Expand the sequence in its detail panel.

Separate importance, confidence, urgency and novelty. A confident minor event stays minor; a potentially serious unverified report stays explicitly unverified. Let the user inspect the ranking explanation: "new evacuation instruction; original authority source; near watched corridor" is useful. An unexplained score of 94 is not.

Balance the visible selection so one prolific publisher or event family cannot dominate by volume. Preserve a route to all admitted reports; editorial diversity must not bury a genuinely dominant major event. Learn the distinction from labelled days and operator decisions, rather than applying an arbitrary permanent fire quota.

### The detail panel is an investigation

- **Sequence:** first public observation, later reports, corrections, cancellations and what the platform knew at each time. Publication delay is visible.
- **Evidence:** exact supporting excerpt or permitted original-media link, publisher, reporting lineage, timestamps, access terms and geography confidence. Separate first-hand evidence from copied reporting.
- **Conflicts:** disagreeing locations, times, figures and explanations. Show what each source actually said and what would resolve the disagreement.
- **Context:** the relevant infrastructure, administrative area, public camera, satellite acquisition or connectivity trace. Context should explain this event; opening it must not launch every layer.
- **Consequences:** supported effects and separately labelled hypotheses, each with a mechanism, evidence and uncertainty. A nearby power station is proximity, not proof of a power outage.
- **Next check:** one or two useful actions—read the original update, compare an earlier frame, inspect an independent measurement, or watch for the authority's next bulletin. A human can dismiss, correct or split the event.

## Five experiences worth building

These are hypothetical investigation flows, not current incidents or fabricated live data.

### 1. The outage before the headline

A regional connectivity baseline changes across multiple networks. Europe Watch surfaces the change with the measurement window, probe coverage and magnitude, then checks whether independent infrastructure or authority sources report an outage. The panel keeps equipment failure, loss of power and measurement failure as competing explanations until evidence distinguishes them.

The map shows the affected measurement area, not a false pinpoint. One click exposes the time series and baseline. A source going offline is also visible; disappearing instruments must not manufacture a larger outage.

### 2. An assembly becoming a consequential event

An announced gathering begins as a calendar item. A permitted public local report adds an observed road closure. A later authority update changes the affected area. These become one evolving event, with planned and observed states kept separate. A map route appears only if its geometry is source-supported.

The feed surfaces the changed access conditions and any explicit public instruction. It does not infer crowd size, violence or political affiliation from the mere existence of a gathering. It does not track individuals or reveal tactical positions.

### 3. A port disruption with visible downstream exposure

A port authority reports a closure; an independently licensed maritime dataset may help test whether arrivals or activity changed. The panel can connect the closure to public infrastructure and documented routes, distinguishing confirmed affected links from potential exposure.

A delayed vessel dataset must carry its latency. "No recent AIS" may be reception loss, normal coverage or a delayed publication; it is not proof of covert activity. The useful output is an investigated operational change, not a collection of dramatic ship icons.

### 4. Smoke, heat and a place that matters

A thermal observation is initially context. Multiple detections, an authority report and a permitted public camera may establish a more useful event. Compare acquisition times, known industrial heat sources and location uncertainty before naming it a wildfire.

The panel can explain whether an actual public instruction or documented infrastructure disruption exists. Satellite detections alone do not justify casualties, spread boundaries or severe-impact labels. Normal industrial heat and repeat detections should disappear into the baseline rather than fill the main feed.

### 5. A slow signal that suddenly explains a fast one

A public procurement award, planning decision or official closure notice can be saved as background to a place or infrastructure asset. When a later material event occurs, the panel retrieves relevant history with dates and direct documents.

This is a contextual research mode. Procurement volume should not become another stream of routine notices in the live queue. Financial or criminal implications need evidence; entity co-occurrence does not establish misconduct.

## Source strategy: complementary evidence

Acquire the earliest useful original source available for a defined question. Prefer structured updates and native identifiers, then licensed local reporting, then contextual imagery. Major media help establish broader consequence and corrections; they are not the only discovery path.

A source earns integration by answering a question the existing set cannot answer at an acceptable cost. Track useful unique events per source-hour, first-original-report lead time, independently corroborated updates, false positives, missed events, bytes, requests and model tokens. Evaluate important misses as carefully as noise.

### Candidate families

All new entries are **research candidates**, not working integrations. Documentation access is not a dataset grant or an availability guarantee. Resolve exact reuse, retention, AI and redistribution terms before a pilot.

| Family                         | Candidate and primary reference                                                                                                                                                                                | Distinct value                                                   | Constraint / pilot question                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internet reachability          | [RIPE Atlas REST API](https://atlas.ripe.net/docs/apis/rest-api-manual/introduction) and [anchor-mesh analysis](https://atlas.ripe.net/docs/tools-and-code/anchor-mesh-status/)                                | Connectivity and path-change evidence with a measurable baseline | Read existing public measurements first. New measurements use credits; sparse probes and shared upstreams can bias conclusions. Can it detect a known regional interruption without mistaking probe loss for an outage? |
| Internet outage corroboration  | [IODA resources and API](https://ioda.inetintel.cc.gatech.edu/resources?tab=repositories)                                                                                                                      | Outage events and time-series evidence complement public reports | Establish API terms, latency and signal lineage. Shared infrastructure can make apparently different signals dependent.                                                                                                 |
| Power systems                  | [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/) and [Web API guide](https://transparency.entsoe.eu/content/static_content/download?path=%2FStatic+content%2Fweb+api%2FRestfulAPI_IG.pdf)      | Published load, generation and unavailability context            | Registration/access and field-specific delays need a pilot. Published unavailability is not proof of customer outages.                                                                                                  |
| Seismic events and felt impact | [EMSC web-service tutorial](https://github.com/EMSC-CSEM/webservices101/blob/master/emsc_services/emsc_services.md)                                                                                            | Instrument events with distinct felt-report context              | Verify present endpoints, rights and update latency. Magnitude, felt intensity and confirmed damage are different fields.                                                                                               |
| Humanitarian / large hazards   | [GDACS](https://www.gdacs.org/)                                                                                                                                                                                | Cross-border disaster discovery and contextual alerting          | Event thresholds and update lags differ from city-level observations. Avoid multiplying one upstream hazard into many independent reports.                                                                              |
| Maritime context               | [Global Fishing Watch events](https://api-doc.globalfishingwatch.org/our-apis/documentation/docs/v3/events) and [access setup](https://api-doc.globalfishingwatch.org/our-apis/documentation/docs/quick-start) | Supported vessel-activity and gap investigations                 | Requires registration/token; verify dataset latency and terms. Fishing activity is not universal real-time port or commercial-fleet coverage.                                                                           |
| Aviation context               | [ADSB.lol API](https://www.adsb.lol/docs/open-data/api/) and [data licence](https://www.adsb.lol/docs/privacy-license)                                                                                         | Public receiver-based aircraft observations                      | ODbL implications, usage limits, receiver coverage and track quality need review. Prefer aggregate disruption context; do not equate missing reception with aircraft behaviour.                                         |
| Aviation access alternative    | [OpenSky API](https://opensky-network.org/data/api) and [terms](https://opensky-network.org/about/terms-of-use)                                                                                                | Possible research and licensed aviation context                  | Current terms require a written licence for operational REST use. Do not promise a free live product integration.                                                                                                       |
| Public spending / projects     | [TED Open Data Service](https://data.ted.europa.eu/)                                                                                                                                                           | Longitudinal infrastructure and institutional context            | Useful for investigations, not a fast-breaking event feed. Verify schema, reuse and entity matching before connecting documents to events.                                                                              |
| City-level originals           | Public authority updates, local emergency information, permitted assembly calendars, licensed local publishers                                                                                                 | Specific places and developments missed by broad feeds           | Choose two pilot cities. Find actual original reporting and correction paths; administrative and passenger notices stay out unless they establish a material event.                                                     |
| Imagery / observations         | Existing publisher camera paths, NASA FIRMS and Copernicus context                                                                                                                                             | Visual or geospatial evidence tied to an investigation           | Keep capture/acquisition time, permission and spatial uncertainty. No background wall of streams or indiscriminate continuous analysis.                                                                                 |
| Public social discovery        | Source-specific permitted public APIs or licensed feeds                                                                                                                                                        | Early public leads and original posts                            | Access/terms remain unresolved for broad deployment. Public claims are leads, not verified facts; never replace blocked access with unsupported scraping.                                                               |

Use source-native pushes or streams where supported; otherwise conditional bounded polling with the source's actual update cadence. Measure publication-to-fetch delay separately from fetch-to-display. Polling a daily dataset every minute does not make its observations live.

## Pareto design: spend compute where it changes a decision

"Pareto" needs measured alternatives. Plot useful-event recall and false-positive burden against operating cost and delay. Keep a cheaper design when extra complexity does not improve those outcomes. No claim of an optimal frontier is justified yet.

### Acquisition and event formation

1. Fetch only changed source material within explicit source and account budgets. Preserve checkpoint/revision identity after durable acceptance.
2. Strip navigation, repeated disclaimers, tracking parameters and publisher boilerplate. Preserve corrections, negation, names needed for disambiguation, quantities, units, dates and relevant place context.
3. Apply source-specific typed admission before queueing analysis. A civic-service announcement, a thermal measurement and a firsthand report need different handling. Keep auditable aggregate exclusion reasons and a small rights-cleared review sample.
4. Use native event IDs and exact fingerprints first. Generate cross-source candidates through bounded time, place, entity and event-type overlap. Avoid a whole-corpus pairwise comparison.
5. Keep reports separate when their relationship is ambiguous. Record candidate links; an incorrect merge can hide a second event. Shared place and keywords alone are insufficient.
6. Build one compact evidence bundle for a material event revision. Rank evidence by novelty, originalness and relevance. Stable references let the output cite it without repeating URLs and metadata.
7. Call Luna for interpretation that deterministic fields cannot provide. Publish structured authority observations and charts without asking a language model to retype them.
8. Cache by evidence revision, model request and contract version. Reuse accepted results; reanalyse when meaningful facts, contradictions or instructions change. Renewing a timestamp is not a meaningful change.

### Luna contract

A short system prompt asks for supported claims, event relationships, unresolved uncertainty and a concise explanation of material change. The input contains the minimum permitted evidence needed for those decisions, with source times and stable references. Operational IDs, transport headers, legal envelopes, repeated history and database dumps stay outside the prompt.

Output should be a small typed object. Deterministic code attaches provenance, links, formatting, display labels and permissions. Enforce a bounded evidence budget and explicitly report omissions. Measure the actual prompt/schema overhead before choosing a batch size; strict structured output can still have a large fixed cost.

No tools by default. Retrieval, when needed, should be a separate approved operation with a budget and a known source—not an invitation to browse arbitrary report text. Images or audio should be analysed only when the specific investigation justifies it and access permits it. Reuse a permitted extracted transcript or selected changed frames instead of repeatedly sending full recordings.

A five-minute headline uses only material changes from that window plus the minimum unresolved context. If there is no meaningful change, retain the previous headline with a clear age or say so. Prevent overlapping obsolete windows from consuming another call. Important pins require explicit support and expiry; there is no quota to fill with drama.

### Storage and serving

Keep ingestion and the durable queue independent from inference availability. Use bounded indexed queries, event revisions and cached client deltas. Apply separate retention to raw material, derived claims, metrics and tombstones; deletion must reach all copies. Benchmark the current D1 design against workload requirements before choosing a migration.

For a larger research corpus and real geometry, evaluate PostgreSQL/PostGIS with an indexed queue first. Add vector retrieval, a broker or search cluster only after simpler baselines fail a measured workload. A permanent free tier is not a reliability strategy; set a capacity envelope and visible degraded modes.

### On-demand audiovisual context

Request the relevant camera or permitted recording when an analyst opens an event. Display capture time, publisher and blind spots. Offer manual side-by-side or time comparison where archival rights exist. Changed-frame selection, OCR or transcription can be a later bounded tool with uncertainty and a visible cost.

No mass stream ingest by default, no automated private-person identification, and no assumed right to archive audio/video. A snapshot of an empty street cannot establish city-wide absence of activity. Radio-style context is limited to lawful public dispatch or authority releases; protected radio access is not an integration shortcut.

## A map that teaches its own limits

A coverage lens should show observed source freshness, domain and geographic coverage, and unavailable feeds. It must not render a uniform green "safe" world. A city can have excellent weather data and no reliable public-event reporting.

Uncertain event areas look different from precise source geometry. Planned, observed, historical and cancelled states remain visually distinct. A count heatmap represents recorded observations and its sampling bias; label it accordingly. Crowd-density or displacement layers require a documented measured dataset, not a density estimate of news articles.

A time scrubber reconstructs what was known then. Replaying an event must not alter the live queue or generate notifications. A user can compare two times and see only changed claims, source additions and corrected geometry. Saved investigations keep the query and evidence revision so a later reviewer can reproduce the reasoning.

## Build order and proof

### First useful release

Choose two cities and one cross-border infrastructure corridor. Bring together local original reporting, one public infrastructure measurement family, authority updates and relevant imagery where permitted. The exact geography follows access and useful signal yield, not a decorative promise to cover every country.

Deliver five complete tasks: find a meaningful change, open its evidence, understand its location/time, distinguish independent reports, and follow its next update without duplicate rows. Build an operator-labelled evaluation set with deliberately quiet days as well as important events. Include normal maintenance, duplicate syndication, corrections, missing geography, delayed reports and unrelated nearby events.

Suggested provisional release gates—targets to review with operators, not achieved results:

- At least 80% of the first ten surfaced items on held-out sessions are judged worth opening by the intended users. Report agreement and sample size.
- At least 90% of a predeclared important-event set within the chosen coverage envelope is found; record how that reference set was assembled and audit misses.
- Every surfaced fact has a traceable permitted evidence reference; no invented precise location, unsupported casualty figure or false independent corroboration in the release sample.
- Five consecutive investigation tasks complete on desktop and phone without losing selection or reading position. Test with people who did not build the interface.
- One unchanged event produces zero additional inference calls; a material revision produces one accepted result under normal operation. Fault injection documents unavoidable repeated computation separately.
- Report source publication delay and processing delay as distributions by family. Set freshness promises only after measuring them.
- Publish measured requests, storage reads/writes, bytes and model tokens for quiet, normal and busy workloads; interruptions preserve queue work.

### Then expand the investigation

Add source contradiction review, evidence lineage, regional comparison, consequence diagrams, bounded audiovisual tools and saved research cases as contextual views. Expand city packs only when a pilot demonstrates incremental useful events and acceptable noise. Introduce alerts after the feed earns attention; otherwise alerts just distribute the same failure faster.

### Later breadth

A provider/plugin contract can let teams add a city pack, infrastructure family or investigative lens with declared rights, update semantics, test fixtures and health checks. A coverage matrix exposes the result of that work. The end state can support many domains without forcing every source into the same article-shaped queue or showing every tool at once.

The [implementation backlog](../TODO.md) translates these ideas into work packages. Completed infrastructure tasks alone cannot satisfy the product gates above.
