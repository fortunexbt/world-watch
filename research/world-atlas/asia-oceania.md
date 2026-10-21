# Asia and Oceania source discovery

This is a curated research supplement for source discovery, not an enabled collector registry. Each JSONL row represents a distinct publisher, outlet or primary institution discovered from the linked publisher page or a source directory. `discovered` means the page or directory entry was found during this research; it does not establish a stable feed, ongoing freshness, access rights, redistribution rights, or suitability for model processing. The app remains paused.

## Counts against the 50-source country goal

This file contains 222 discovered records across 26 publisher-country codes. Counts below include existing newspaper/broadcaster discoveries and specialist primary-source additions from this pass.

| Publisher country (ISO alpha-2) | Discovered | Shortfall to 50 |
| --- | ---: | ---: |
| Japan (JP) | 58 | 0 |
| Indonesia (ID) | 52 | 0 |
| India (IN) | 9 | 41 |
| Bangladesh (BD) | 8 | 42 |
| Papua New Guinea (PG) | 7 | 43 |
| Solomon Islands (SB) | 7 | 43 |
| Tonga (TO) | 7 | 43 |
| Australia (AU) | 6 | 44 |
| Fiji (FJ) | 6 | 44 |
| Pakistan (PK) | 6 | 44 |
| Samoa (WS) | 6 | 44 |
| Vanuatu (VU) | 6 | 44 |
| Nepal (NP) | 5 | 45 |
| New Zealand (NZ) | 5 | 45 |
| Philippines (PH) | 5 | 45 |
| Taiwan (TW) | 5 | 45 |
| Thailand (TH) | 5 | 45 |
| Malaysia (MY) | 4 | 46 |
| South Korea (KR) | 4 | 46 |
| Sri Lanka (LK) | 4 | 46 |
| Kiribati (KI) | 2 | 48 |
| Federated States of Micronesia (FM) | 1 | 49 |
| Marshall Islands (MH) | 1 | 49 |
| New Caledonia (SPC base) (NC) | 1 | 49 |
| Palau (PW) | 1 | 49 |
| Tuvalu (TV) | 1 | 49 |

These are exact counts in this file, not claims of complete national coverage. Japan and Indonesia have the only 50+ country totals in this regional file. New additions emphasize primary hazard instruments, weather and marine warnings, disaster situation reports, environmental monitoring and public-health surveillance; these increase source-family diversity but remain far below the 50-per-country target in most countries. Counts are deliberately not padded with guessed feeds, routine administrative pages or repeated variants from one publisher.

## Discovery and provenance

Japan's local newspapers were selected from the National Diet Library's current directory of national and regional newspaper sites, updated 8 January 2026: [National Diet Library, newspaper site directory](https://ndlsearch.ndl.go.jp/rnavi/newspapers/post_700033). The national newspapers, NHK and wire services are listed by the Japan Newspaper Publishers & Editors Association: [Pressnet member news organizations](https://www.pressnet.or.jp/english/member/). The catalogue gives a strong geographic spread across Hokkaido, Tohoku, Kanto, Hokuriku, Chubu, Kinki, Chugoku, Shikoku, Kyushu and Okinawa. Several directory URLs are HTTP; the recorded URLs retain the directory's linked destination where HTTPS was not listed.

Indonesia's national and regional digital outlets were selected from a dated directory that labels a subset as press-council verified and shows regional coverage. The directory is a commercial third-party catalog, so it is provenance for discovery and its labels are not independently asserted here as legal or editorial certification: [complete media directory](https://www.arfadia.com/resources/media-directory/all), [press-council-listed subset](https://www.arfadia.com/resources/media-directory/dewan-pers). The Indonesian Press Council also exposes an official, dynamically loaded company register at [Data Perusahaan Pers](https://dewanpers.or.id/data); its current interactive table did not expose individual source URLs in the page text during this pass. Publisher-owned homepages were recorded as the source URLs. The 52 rows mix national general, investigative and business news with regional outlets covering Sumatra, Java, Bali, Kalimantan, Sulawesi, Maluku and Aceh; groups and syndication still need ownership-lineage review before any connector is admitted.

The Pacific additions use local publisher pages as source URLs and direct source pages or public directories as provenance. Examples include the [Fijian Broadcasting Corporation newsroom](https://www.fbcnews.com.fj/section/news/news/), PNG national papers and broadcasters, Samoa's [Law Reform Commission media report](https://www.samoalawreform.gov.ws/wp-content/uploads/2023/10/Final-Report-Eng-10.pdf), the Tongan embassy's [media guide](https://tonga-gov.pt/noticias-e-meios-de-comunicacao-em-tonga/) and [Pacific Islands News Association member profile for Talanoa 'o Tonga](https://pina.com.fj/pina-members/talanoa-o-tonga/), and ABC International Development's 2025 [Solomon Islands media landscape](https://www.abc.net.au/abc-international-development/state-of-the-media-solomon-islands-2025/). Palau, RMI and FSM each have a single current local newsroom discovered directly: [Island Times](https://islandtimes.org/), [Marshall Islands Journal](https://marshallislandsjournal.com/), and [Kaselehlie Press](https://kpress.fm/about-us/). The Marshall Islands Journal homepage notes a subscription for full content; no paywalled material was accessed.

Cross-border coverage is noted on individual rows when explicit (for example Fiji-based Islands Business and Pacific regional coverage from local broadcasters). `country_code` records the publisher's base, not every country a source covers. No row is a feed endpoint or a claim about fetchability.

This pass also verified government and specialist source pages directly: India’s [IMD warning portal](https://mausam.imd.gov.in/index_en.php?lang=en), [NCS reviewed earthquake list](https://riseq.seismo.gov.in/riseq/earthquake/), and [INCOIS ocean-state forecasts](https://incois.gov.in/oceanservices/osfforecast.jsp); Bangladesh’s [DDM reports](https://ddm.gov.bd/pages/reports), [BWDB Flood Forecasting and Warning Centre](https://ffwc.gov.bd/), and [DGHS dengue dashboard](https://dashboard.dghs.gov.bd/pages/heoc_dengue_v1.php); Pakistan’s [NDMA situation reports](https://ndma.gov.pk/sitreps); Nepal’s [NDRRMA daily bulletins](https://ndrrma.gov.np/np/daily-bulletin) and [DHM flood forecasts](https://dms2.dhm.gov.np/); Sri Lanka’s [weekly epidemiological reports](https://epid.gov.lk/epid/public/index.php/weekly-epidemiological-report/weekly-epidemiological-report); Philippines’ [PAGASA cyclone and climate products](https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin) and [PHIVOLCS volcano monitoring](https://volcano.phivolcs.dost.gov.ph/); Taiwan’s CWA and NCDR alert systems; Korea’s KDCA weekly reports and KMA earthquake/warning pages; Thailand’s TMD, DDPM and disease-surveillance portals; Malaysia’s NADMA and MetMalaysia; Australia’s BOM, CDC and Geoscience Australia; and New Zealand’s NEMA, GeoNet and MetService. The Pacific authority pass confirmed public national meteorology or warning endpoints for [Kiribati](https://met.gov.ki/), [Tuvalu](https://tuvmet.tv/index.php/), [Solomon Islands](https://met.gov.sb/severe-weather-warnings/) and [Papua New Guinea](https://www.pngmet.gov.pg/public-wx/warnings/); it also added current local reporting from [Kiribati BPANews](https://bpa.org.ki/category/news/) and the [Pacific Public Health Surveillance Network](https://www.pphsn.net/), which explicitly covers 23 Pacific island countries and is developed by the Pacific Community. These are publisher/institution pages used as provenance; the entries record discovery, not reuse permission or operational feed status.

## Admission work still required

Before any source can be enabled, determine editorial ownership and syndication lineage, geographic precision, update cadence and latency, terms and attribution, access/storage/model/display/redistribution permissions, and whether a source produces useful event reporting rather than routine notices. The discovered URLs are leads for that review; this inventory grants no reuse permission.
