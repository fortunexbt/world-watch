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
| Regional hazard warnings            | NWS storm-based warnings, ECCC warnings                            | Issuer warnings published without a model. Points are polygon centres with a radius covering the warned area, not exact locations.        |

Passenger-train circulation and institutional-announcement feeds were disabled after they overwhelmed the feed. Fire/thermal coverage can still dominate. Adding more endpoints without a usefulness test would repeat that failure.

## Worldwide hazards

USGS supplies the complete past-day earthquake summary at magnitude 4.5 and above, the level at which its catalogue is complete worldwide. Each record keeps the USGS event ID and update time, magnitude, depth, review status, PAGER alert and tsunami flag. The tsunami flag marks a large oceanic event and does not mean a tsunami occurred. USGS states no country. The adapter derives one from the epicentre with the map's own Natural Earth 1:110m boundaries (`public/countries.geojson`, compiled to `src/shared/borders.json` by `scripts/borders.mjs`), never a geocoding service. A country is set only when the epicentre lies inside one polygon and at least 40 km from every edge. At that margin none of 33,806 GeoNames localities fell in the wrong country, except Simferopol, because this edition draws Crimea inside Russia. Offshore epicentres, those near a coast or border, and those in uncoded territories such as Northern Cyprus and Somaliland keep a null country. USGS-authored data is U.S. public domain, and USGS asks for credit as "U.S. Geological Survey". A preferred event ID can change when another network becomes authoritative, which can briefly duplicate an earthquake.

GDACS supplies current Orange and Red alerts for earthquakes, tropical cyclones, floods, volcanoes, droughts and wildfires. GDACS returns at most 100 events per page. On 21 October 2026 `pagesize=200` still returned 100 and `pagenumber=2` returned the next page, and on 22 October a page past the end answered 204 No Content. The collector follows `pagenumber` until a short or empty page, for up to three pages (`max_pages`) and within the run's request budget. The Orange and Red list held 87 events on 22 October, so a normal read costs one page request and one reconciliation call, and every further 100 events costs one more request. If the page cap or the request budget stops paging early, the run fails visibly and nothing from it is published or reconciled. GDACS is slow to answer: six reads of the first page on 23 October 2026 took 42.6, 74.9, 1.6, 33.8, 23.6 and 33.0 seconds, nearly all of it before the first byte, so the collector's 15-second default failed most of them. GDACS requests therefore wait up to 90 seconds (`timeout_ms`), which covers the slowest read seen with some room and stays inside the ten-minute poll interval. Other sources keep the default.

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

## United States warnings

NWS supplies its active storm-based warnings through `api.weather.gov`: tornado, severe thunderstorm, flash flood, flood, extreme wind, snow squall and dust storm warnings. NWS draws each of these as its own polygon. On 22 October 2026 the unfiltered active list held 403 alerts in 1.9 MB, and 371 had no geometry. Those are zone-based alerts (watches, advisories, statements and winter, heat, tropical and marine warnings) whose areas exist only as forecast-zone codes, and mapping them would take a further request per zone, so they are not collected. Filtering by severity instead would have kept 83 Severe and Extreme alerts, 66 of them without a polygon, and would also drop every cancellation, because NWS issues cancellations at severity Minor. The storm-based query returned 16 messages in 117 kB that day. Two were repeats of the same message, which left 14 warnings. The `status=actual` filter keeps test, exercise and system messages out, and the parser checks status again.

The API returns Atom unless asked for GeoJSON, so this source sends `Accept: application/geo+json`. The parser drops messages without an operational VTEC warning code or without a polygon. Each warning is identified by its VTEC office, phenomenon, significance and event number plus the year of its first message, because event numbers restart every January. Every NWS message about the warning is a revision of that one record, and the latest message wins when the active list repeats one. The event starts when NWS first issued the warning, taken from the earliest message the latest one references. It ends at the issuer's stated hazard end, or at the message expiry for a river flood warning with no stated end. A VTEC `CAN` or `UPG` marks the warning cancelled. An `EXP` message is not a cancellation. It leaves the warning to lapse at its stated end. Each record keeps the NWS message ID, event, VTEC string, CAP severity, certainty and urgency, issuing office, area description, times, the issuer's hazard tags (hail size, wind gust, tornado and flash-flood detection and damage threat) and the description and instruction text unchanged. The country is US, or the territory code for Puerto Rico, Guam, American Samoa, the U.S. Virgin Islands or the Northern Mariana Islands, when every UGC code in the warning names the same one.

The map point is the centre of the polygon's bounding box. The radius reaches the polygon's farthest vertex, so the circle covers the whole warned area and some ground outside it. The incident contract carries points, not polygons, and the excerpt says so.

NWS content is U.S. public domain and may be used for any lawful purpose as long as it isn't claimed as one's own, doesn't imply NOAA or NWS endorsement and isn't modified and then presented as official ([NWS disclaimer](https://www.weather.gov/disclaimer), checked 22 October 2026). The [API documentation](https://www.weather.gov/documentation/services-web-api) describes the data as open and free to use for any purpose, with a User-Agent required and an unpublished rate limit. The collector's existing User-Agent names the application but carries no contact address, which NWS recommends and does not require. Warning text is kept unchanged, and World Watch's impact labels and points are marked as its own.

| CAP severity | Impact        |
| ------------ | ------------- |
| Minor        | informational |
| Moderate     | minor         |
| Severe       | significant   |
| Extreme      | severe        |
| Unknown      | unknown       |

CAP severity states a threat to life or property, not observed harm, so each level maps one step down and Extreme never reaches critical. In the messages checked on 22 October 2026, severe thunderstorm, flash flood and flood warnings were Severe, tornado warnings were Extreme and cancellations were Minor. Tornado and flash flood emergencies don't change the mapping, because their wording states a threat rather than counted casualties. VTEC TO, SV, EW, SQ and DS warnings map to the `severe_weather` activity, and FF, FA and FL warnings map to `flood`.

## Canada warnings

ECCC supplies current public weather alerts through the MSC GeoMet OGC API at `api.weather.gc.ca`, one GeoJSON feature per alert per forecast region, each with the region's polygon. On 22 October 2026 the unfiltered collection held 53 features: 11 warnings, 30 special weather statements and 12 fog and frost advisories, 11 of them already ended. The source queries warnings only, which returned 11 features in 32 kB. Watches, advisories and statements are not collected. The query asks for up to 500 features, and a response whose `numberMatched` differs from the features returned fails visibly rather than dropping warnings.

Each record uses ECCC's feature ID, which joins the alert and the forecast region. Two polls 20 minutes apart on 22 October 2026 caught ECCC reissuing nine features, first published at 13:25 UTC and again at 18:28 or 18:30, under unchanged IDs. A reissued warning is therefore a revision of the same record. A wind warning and a blizzard warning for the same region are separate records. The status `ended` marks the warning cancelled, since ECCC ends warnings explicitly. The event starts at ECCC's validity time and ends at its stated event end, or at the message expiry when no event end is given. Each record keeps the English and French alert names and text unchanged, the status, colour, ECCC's impact and confidence ratings, the region and province, and the issue, validity, event-end and expiry times. The country is CA. The map point is the centre of the region's bounding box and the radius reaches its farthest vertex, so the circle covers the whole region and some ground outside it.

The [ECCC Data Services End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/) (version 2.1.1, checked 22 October 2026) grants a worldwide, royalty-free, perpetual licence to copy, publish, distribute and adapt the information, including commercially. It requires the attribution "Data Source: Environment and Climate Change Canada" with a link to the licence where possible, forbids implying endorsement, provides the data as is, and requires weather warnings to be reproduced without altering their content or intent. Warning text is therefore kept verbatim in both languages, and World Watch's title, impact label and point are its own derivations. The [MSC Open Data usage policy](https://eccc-msc.github.io/open-data/usage-policy/readme_en/) asks users above 86,400 requests a day to get in touch and asks for a meaningful User-Agent. A five-minute poll makes 288.

| ECCC colour | Impact      |
| ----------- | ----------- |
| Yellow      | minor       |
| Orange      | significant |
| Red         | severe      |
| None        | unknown     |

ECCC's colour is its own rating of expected impact, not observed harm. Red, ECCC's "very dangerous" level, still maps to severe and never to critical. Hurricane and tropical storm warnings map to the `tropical_cyclone` activity, storm surge warnings to `flood`, and every other warning, including rainfall, wind, blizzard, heat and cold, to `severe_weather`. A rainfall warning forecasts heavy rain and does not state flooding, so it isn't mapped to `flood`.

## Reviewed and not integrated

These hazard feeds were checked on 22 October 2026 and left out.

- NOAA tsunami warning centres (`tsunami.gov` Atom feeds `PHEBAtom.xml` and `PAAQAtom.xml`). The content is U.S. public domain, but each feed holds only the latest bulletin from its centre, and both held information statements saying there was no tsunami threat. With no live warning, advisory or watch to sample, the warning categories, cancellation and expiry couldn't be verified against real bulletins, and the epicentre point would misplace a threat to distant coasts. NWS still carries US tsunami alerts, but as zone-based alerts without polygons.
- USGS volcano alert levels (HANS public API at `volcanoes.usgs.gov/hans-public/api`). The content is U.S. public domain, but the yield was four volcanoes, one at Watch/Orange and three at Advisory/Yellow. The elevated list has no coordinates, so a second catalogue request would be needed, and the CAP list covers only Watch and Warning. Advisory and Watch describe unrest as well as eruption, which the `volcanic_eruption` activity would overstate, and GDACS already maps Orange and Red volcanic events worldwide.
- Smithsonian Global Volcanism Program. A bounded request for its terms of use returned a bot challenge instead of the terms, so reuse rights couldn't be established.

## Admission contract

Before enabling a source, establish its geographic scope, publisher and upstream origin, update semantics, typical latency, reliability, terms, attribution, and separate permissions for access, storage, model use, display and redistribution. Record the specific grant or blocker. Public reachability is not a grant.

Use approved HTTPS origins and bounded response sizes. Do not follow report-supplied URLs automatically or forward application/service credentials to publishers. Conditional requests and checkpoints advance after durable acceptance. Repeated content, boilerplate and unchanged revisions should not create model work.

Use native episode identity where available. Cross-source bundles need evidence of shared event identity and must preserve contradictions and original source links. Reposted material from one origin counts as one reporting lineage. New material facts, corrections and cancellation can require a new analysis; "one call per event" cannot mean freezing the event forever.

Missing geography remains unknown. Municipality centroids are approximate areas, not exact incident coordinates. Planned assemblies, crowd estimates, observed attendance, evacuation orders and measured displacement are distinct observations. Dataset silence does not establish that nothing happened.

Retention and deletion must propagate through source text, derived claims, search, caches, exports and local spools. Dataset permission and personal-data risk must be reviewed before publishing examples. This repository intentionally omits the collected operational corpus.

## Expansion

[The vision](VISION.md) proposes complementary signal families with primary-source references and access limits. [The backlog](../TODO.md) defines pilots and acceptance tests. Candidates remain research until their rights, useful event yield and operating cost are established; no unimplemented connector should appear as live coverage.
