# Sources and admission

The executable inventory is [`src/collector/registry.ts`](../src/collector/registry.ts). A listed, enabled or reachable endpoint does not establish useful coverage. The deployment is paused, and this document makes no current freshness claim.

## Existing paths

| Family                              | Example adapters or registry entries                               | Interpretation and gap                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Selected public police/fire reports | Norway Politiloggen, Sweden Polisen, Catalunya Bombers, Zwaailicht | Publisher-selected messages; many minor incidents. Native episode IDs help grouping, but duplication and relevance still need evaluation. |
| Planned gatherings                  | Demos calendar                                                     | Announced activity, not measured attendance or confirmed turnout.                                                                         |
| Displacement                        | IDMC Ukraine via HDX                                               | Provisional flows; not live individual movement or a cumulative population count.                                                         |
| Official warnings and calendars     | BBK, MIT strikes, selected Paris records                           | Keep issuer validity and explicit geographic scope. Rights restrictions may prohibit model processing.                                    |
| Public cameras                      | Statens vegvesen, Digitraffic                                      | Selected public publisher-operated imagery. Snapshot time, update cadence and playback permission vary.                                   |
| Satellite/context                   | NASA FIRMS, Copernicus Emergency Management Service                | Thermal observations and emergency mapping areas; neither establishes incident severity or affected population.                           |
| Worldwide natural hazards           | USGS earthquakes, GDACS alerts                                     | Structured records published without a model. Points are epicentres or alert centroids, not impact footprints.                            |

Passenger-train circulation and institutional-announcement feeds were disabled after they overwhelmed the feed. Fire/thermal coverage can still dominate. Adding more endpoints without a usefulness test would repeat that failure.

## Worldwide hazards

USGS supplies the complete past-day earthquake summary at magnitude 4.5 and above, the level at which its catalogue is complete worldwide. Each record keeps the USGS event ID and update time, magnitude, depth, review status, PAGER alert and tsunami flag. The tsunami flag marks a large oceanic event and does not mean a tsunami occurred. USGS states no country. The adapter derives one from the epicentre with the map's own Natural Earth 1:110m boundaries (`public/countries.geojson`, compiled to `src/shared/borders.json` by `scripts/borders.mjs`), never a geocoding service. A country is set only when the epicentre lies inside one polygon and at least 40 km from every edge. At that margin none of 33,806 GeoNames localities fell in the wrong country, except Simferopol, because this edition draws Crimea inside Russia. Offshore epicentres, those near a coast or border, and those in uncoded territories such as Northern Cyprus and Somaliland keep a null country. USGS-authored data is U.S. public domain, and USGS asks for credit as "U.S. Geological Survey". A preferred event ID can change when another network becomes authoritative, which can briefly duplicate an earthquake.

GDACS supplies current Orange and Red alerts for earthquakes, tropical cyclones, floods, volcanoes, droughts and wildfires. GDACS returns at most 100 events per page. On 21 October 2026 `pagesize=200` still returned 100 and `pagenumber=2` returned the next page, and on 22 October a page past the end answered 204 No Content. The collector follows `pagenumber` until a short or empty page, for up to three pages (`max_pages`) and within the run's request budget. The Orange and Red list held 87 events on 22 October, so a normal read costs one page request and one reconciliation call, and every further 100 events costs one more request. If the page cap or the request budget stops paging early, the run fails visibly and nothing from it is published or reconciled.

Green alerts stay excluded. On 22 October 2026 a Green-inclusive list ran past six full pages. Its first 600 events held 331 current ones, and 329 of those were Green: 231 wildfires, 85 earthquakes, 9 floods and 4 cyclones. They would all map at impact minor, the wildfires are GWIS satellite detections beside the FIRMS thermal layer, and a first load would cost at least four page requests and about 110 ingest requests against the collector's 40-request run budget.

Only events GDACS marks as current are published, because its Orange and Red results also list archived events (62 of 63 on 22 October 2026). GDACS states no validity time, so a current event carries no expiry and stays live, however long ago it started, while GDACS lists it as current. After each complete read the collector sends the current event IDs to the source's reconcile endpoint. An incident whose event is no longer listed gets a new revision that clears `current_listing` and sets its expiry to the time World Watch saw it leave. It is not marked cancelled or corrected, and that expiry suppresses urgent alerts under the existing rules. This replaced a rule that expired events 24 hours after their latest GDACS observation: on 22 October, 68 of the 86 current earthquakes across all alert levels had a latest observation over 24 hours old, and GDACS kept some current for four days.

GDACS can mark a drought archived while its assessments continue: four of the six Orange droughts listed on 22 October 2026 were archived with an assessment dated two days earlier. Those droughts don't reach the map. Liveness depends on the collector reading GDACS, so a stopped collector leaves the last current set live. An event whose record changes while pages are being read can move to a page already read and be missed. It is ended for that poll and returns on the next, because its record has changed. An event GDACS lists again with an unchanged record stays ended until its record changes.

Each record keeps the hazard type and event ID, the episode as its revision, alert levels, start and latest dates, affected countries and the upstream hazard provider. A country is set only when GDACS lists exactly one affected country. The European Commission legal notice linked by GDACS grants CC BY 4.0 with attribution and excludes third-party material, such as the GLOFAS, JTWC and GWIS inputs named in each record. GDACS provides its data as is and not for decision making without prior confirmation, so these records are not redistributed in exports.

Both sources set impact from the native alert level and never ask a model.

| Native level                        | Impact      |
| ----------------------------------- | ----------- |
| USGS PAGER green, GDACS Green       | minor       |
| USGS PAGER yellow, GDACS Orange     | significant |
| USGS PAGER orange or red, GDACS Red | severe      |
| None or unrecognised                | unknown     |

Alert levels are modelled estimates of losses or humanitarian impact, not observed harm. They never map to critical, which needs stated mass-casualty evidence. GDACS reports the highest alert across an event's episodes, and the current episode level stays in the record.

## Admission contract

Before enabling a source, establish its geographic scope, publisher and upstream origin, update semantics, typical latency, reliability, terms, attribution, and separate permissions for access, storage, model use, display and redistribution. Record the specific grant or blocker. Public reachability is not a grant.

Use approved HTTPS origins and bounded response sizes. Do not follow report-supplied URLs automatically or forward application/service credentials to publishers. Conditional requests and checkpoints advance after durable acceptance. Repeated content, boilerplate and unchanged revisions should not create model work.

Use native episode identity where available. Cross-source bundles need evidence of shared event identity and must preserve contradictions and original source links. Reposted material from one origin counts as one reporting lineage. New material facts, corrections and cancellation can require a new analysis; "one call per event" cannot mean freezing the event forever.

Missing geography remains unknown. Municipality centroids are approximate areas, not exact incident coordinates. Planned assemblies, crowd estimates, observed attendance, evacuation orders and measured displacement are distinct observations. Dataset silence does not establish that nothing happened.

Retention and deletion must propagate through source text, derived claims, search, caches, exports and local spools. Dataset permission and personal-data risk must be reviewed before publishing examples. This repository intentionally omits the collected operational corpus.

## Expansion

[The vision](VISION.md) proposes complementary signal families with primary-source references and access limits. [The backlog](../TODO.md) defines pilots and acceptance tests. Candidates remain research until their rights, useful event yield and operating cost are established; no unimplemented connector should appear as live coverage.
