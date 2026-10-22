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
| Aviation emergency signals          | ADSB.lol emergency squawks                                         | Transponder codes set by flight crews and heard by volunteer receivers, published unverified. Receiver coverage has large gaps.          |

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

## Aviation emergency squawks

ADSB.lol supplies the aircraft its volunteer receivers hear squawking 7500, 7600 or 7700 through `api.adsb.lol/v2/sqk`. The endpoint accepts a comma-separated list, so one request covers all three codes: on 22 October 2026 a `1200,7000` query returned both codes in one response. Each response carries a `total` count, and one that differs from the aircraft returned fails visibly. On 22 and 23 October the API answered with rate limits of 4 requests a second, 60 a minute and 500 a day. A five-minute poll makes 288 requests a day.

A squawk is a four-digit transponder code that the flight crew sets. 7700 declares a general emergency, 7600 a radio failure and 7500 unlawful interference. Crews also set these codes by mistake, for example while dialling another code, or as a precaution, and many 7700 flights are medical diversions or precautionary landings that end normally. Air traffic control knows whether an emergency is real, and nothing in this feed confirms one. The records therefore publish with evidence status `unverified`, never `official_advisory`. Urgent alerts need severe impact and supported evidence, so these records never raise one.

Each record is one aircraft, identified by its ICAO 24-bit address (`hex`), and one code. Its ID adds the UTC minute World Watch first saw the pair, and the collector carries that ID forward while the previous complete read still listed the aircraft with the code. Each later position is a revision of the same incident, and the start stays at the first sighting, which can trail the crew's change by up to one poll. When ADSB.lol stops listing the aircraft with the code, the collector's complete current list no longer contains it and the incident ends as GDACS events do: `current_listing` is cleared and the expiry records when World Watch saw it go, without marking it cancelled. That happens when the crew clears the code, and also when the aircraft lands and switches off or leaves receiver coverage, which the feed can't tell apart. A later sighting opens a new episode, and an aircraft that changes from 7700 to 7600 ends one episode and opens another.

The point is the position in the response, or readsb's `lastPosition` when the live position is more than 60 seconds old. Its accuracy is `point`, and the radius covers the ground the aircraft could have covered between that fix and the response at its reported ground speed, with a floor of 1 km for multilateration error. The aircraft keeps moving between polls, and the record states the time of the fix. The country is derived from the point and the map's own boundaries, as for USGS epicentres, and stays empty over the sea or near a border. An aircraft listed without any position is stored so its episode continues, but it isn't mapped.

Each record keeps the address, callsign, code and its meaning, readsb's ADS-B emergency status, aircraft type designator, ground flag, barometric altitude, ground speed, track, vertical rate, the military database flag, the position source (ADS-B, multilateration or TIS-B), the position time and the first and latest sightings. It leaves out the registration and any owner or operator field. Aircraft flagged with a Privacy ICAO Address or on the FAA LADD list are skipped, because their operators asked not to be shown publicly. A private aircraft's callsign can still be its registration.

| Code | Meaning               | Impact        |
| ---- | --------------------- | ------------- |
| 7500 | unlawful interference | significant   |
| 7700 | general emergency     | minor         |
| 7600 | radio failure         | informational |

The impact is a cautious reading of a self-reported code, not a report of harm. A genuine 7500 would be grave, but the code alone is unconfirmed and often set in error, so it stays at significant unless an issuer confirms it, and no issuer feed is integrated. 7700 declares an abnormal situation and says nothing about harm. 7600 starts a lost-communications procedure.

The [API documentation](https://api.adsb.lol/docs) (checked 22 October 2026) states that the API "as well as all data ADSB.lol makes public" is licensed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). It says the API is free to use, that "in the future, you will require an API key which you can get by feeding to adsb.lol", and asks production users to get in touch first. The [docs page](https://www.adsb.lol/docs/open-data/api/) marks the public API deprecated in favour of re-api, which only feeders can reach from their station's address. The [privacy and licence page](https://www.adsb.lol/docs/privacy-license) provides the data as is, asks users to indemnify ADSB.lol against third-party claims arising from non-conforming use, and gives `info [at] adsb.lol` as the contact. A resumed hosted deployment should contact ADSB.lol first and expect to need a feeder key.

The ODbL permits storage, display and redistribution with these conditions:

- A publicly used produced work, such as the map, needs a notice that it contains information from the database under the ODbL (section 4.3). The map's attribution line and each record's attribution carry that notice with links to ADSB.lol and the licence, and the record text repeats it.
- The extracted records form a derivative database that must stay under the ODbL when publicly used (4.4). Exports, which already carry each record's attribution and licence basis, therefore include them, and they mustn't be relicensed. The rest of World Watch's database is a collective database the ODbL doesn't reach (4.5a), since aviation records aren't merged with records from other sources.
- Whoever receives the derivative database or a produced work must be offered the derivative database or the method that made it (4.6). The export is the first and this adapter, in a public repository, is the second. Sign-in is allowed if it doesn't restrict those rights (4.7c).

Coverage depends on where volunteers run receivers. It is dense over Europe and North America and thin or absent over the oceans, polar routes and much of Africa and Asia. An emergency outside coverage never appears, and an empty list doesn't mean no aircraft is squawking an emergency code. On the evening of 22 October 2026 the list was empty at 23:37 UTC, while the same endpoint returned 1,044 aircraft squawking 1200.

## Reviewed and not integrated

These hazard feeds were checked on 22 October 2026 and left out.

- NOAA tsunami warning centres (`tsunami.gov` Atom feeds `PHEBAtom.xml` and `PAAQAtom.xml`). The content is U.S. public domain, but each feed holds only the latest bulletin from its centre, and both held information statements saying there was no tsunami threat. With no live warning, advisory or watch to sample, the warning categories, cancellation and expiry couldn't be verified against real bulletins, and the epicentre point would misplace a threat to distant coasts. NWS still carries US tsunami alerts, but as zone-based alerts without polygons.
- USGS volcano alert levels (HANS public API at `volcanoes.usgs.gov/hans-public/api`). The content is U.S. public domain, but the yield was four volcanoes, one at Watch/Orange and three at Advisory/Yellow. The elevated list has no coordinates, so a second catalogue request would be needed, and the CAP list covers only Watch and Warning. Advisory and Watch describe unrest as well as eruption, which the `volcanic_eruption` activity would overstate, and GDACS already maps Orange and Red volcanic events worldwide.
- Smithsonian Global Volcanism Program. A bounded request for its terms of use returned a bot challenge instead of the terms, so reuse rights couldn't be established.

These aviation feeds were checked on 22 October 2026 and left out.

- airplanes.live. Its [API documentation](https://airplanes.live/api-docs/) lists squawk and military endpoints but states no data licence. Its [terms of use](https://airplanes.live/terms-of-use/) grant content "for your personal, non-commercial use or internal business purpose only", forbid systematically retrieving data "to create or compile, directly or indirectly, a collection, compilation, database, or directory without written permission" and forbid automated access by script. A public application would need written permission.
- adsb.fi. Its [open data terms](https://github.com/adsbfi/opendata) say the data "is for personal, non-commercial use only", require citing adsb.fi with a link and limit public endpoints to one request a second. A public application isn't personal use.
- OpenSky Network. Its [terms](https://opensky-network.org/about/terms-of-use) require a written licence for operational use.
- ADSB.lol military aircraft (`/v2/mil`). The same ODbL covers it, but it is not a signal of anything happening. On 22 October 2026 at 23:37 UTC it listed 286 aircraft, 226 with a position. The military tag is a flag in a community aircraft database whose completeness isn't stated, and a position alone doesn't say what a flight is doing, so routine training and transport flights would read as activity. A moving layer also needs the current-state and track retention the [core plan](plans/GLOBAL_OSINT_CORE_PLAN.md) asks for before more aviation feeds, and its requests would come out of the same 500-a-day allowance as the squawk poll.

These internet connectivity sources were checked on 23 October 2026 and left out.

- IODA, Georgia Tech's Internet Outage Detection and Analysis (`api.ioda.inetintel.cc.gatech.edu/v2`). The API needs no key, and `/v2/outages/events` would suit a connectivity signal. Each event names a country, region or network, the measurement (BGP prefix visibility, active probing of /24 blocks, the Merit network telescope or Google Transparency Report traffic), the detection method, a start, a duration and a score. The past day held 41 country events in 30 countries and 251 region events in 202 regions. Every response states "This data is Copyright (c) 2021-2025 Georgia Tech Research Corporation. All Rights Reserved." Neither the [API documentation](https://api.ioda.inetintel.cc.gatech.edu/v2/) nor the [IODA site](https://ioda.inetintel.cc.gatech.edu/resources?tab=repositories) publishes a data licence or terms of use, and the [CAIDA catalogue](https://catalog.caida.org/dataset/ioda) entry has no licence. The `LICENSE` in [InetIntel/ioda-api](https://github.com/InetIntel/ioda-api) covers the software, and only for academic research and education. Displaying or redistributing the events would need written permission from the IODA team, whom the site asks to be contacted at ioda-info@cc.gatech.edu.
- Cloudflare Radar outage annotations (`api.cloudflare.com/client/v4/radar/annotations/outages`). The API refuses requests without a Cloudflare account token, and [Radar's documentation](https://developers.cloudflare.com/radar/) licenses the data under CC BY-NC 4.0.

## Admission contract

Before enabling a source, establish its geographic scope, publisher and upstream origin, update semantics, typical latency, reliability, terms, attribution, and separate permissions for access, storage, model use, display and redistribution. Record the specific grant or blocker. Public reachability is not a grant.

Use approved HTTPS origins and bounded response sizes. Do not follow report-supplied URLs automatically or forward application/service credentials to publishers. Conditional requests and checkpoints advance after durable acceptance. Repeated content, boilerplate and unchanged revisions should not create model work.

Use native episode identity where available. Cross-source bundles need evidence of shared event identity and must preserve contradictions and original source links. Reposted material from one origin counts as one reporting lineage. New material facts, corrections and cancellation can require a new analysis; "one call per event" cannot mean freezing the event forever.

Missing geography remains unknown. Municipality centroids are approximate areas, not exact incident coordinates. Planned assemblies, crowd estimates, observed attendance, evacuation orders and measured displacement are distinct observations. Dataset silence does not establish that nothing happened.

Retention and deletion must propagate through source text, derived claims, search, caches, exports and local spools. Dataset permission and personal-data risk must be reviewed before publishing examples. This repository intentionally omits the collected operational corpus.

## Expansion

[The vision](VISION.md) proposes complementary signal families with primary-source references and access limits. [The backlog](../TODO.md) defines pilots and acceptance tests. Candidates remain research until their rights, useful event yield and operating cost are established; no unimplemented connector should appear as live coverage.
