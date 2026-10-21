# World source atlas foundation

Research cut: 21 October 2026. This file describes discovery catalogs and the boundary between a source lead and an admitted connector. The application remains paused. The adjacent `catalog-candidates.jsonl` is a machine-readable discovery seed; it is not a live registry and must not be treated as authorization to collect, analyze, display, or republish content.

## Highest-yield public catalog tested

The [Media Directory data and method page](https://media.datainfo.ai/en/about/) reports a 13 September 2026 snapshot of 56,856 active media outlets with official websites, drawn from Wikidata records with a preferred-website (`P856`) statement. It filters news agencies, newspapers, online newspapers, magazines, television, radio, and broadcasters. It records country from Wikidata `P17`, falling back to `P495`; that is publisher/source country metadata, not a claim about where a reported event occurred. Its stated terms for Wikidata fields are CC0. Its own limitations include uneven country coverage, possible historical outlets that lack a dissolution date, and a small amount of non-news magazine material.

The site says it keeps open the underlying CSV files and pull pipeline. Its browser client downloads the full static [index JSON](https://media.datainfo.ai/data/2026-09-13-7a3b9628/index.json), even though the visible shortlist export is capped at 200 records and the site markets a separate full-list product with extra channel information. A bounded fetch of that index returned HTTP 200, `application/json`, 4,232,868 bytes. The complete object had 56,856 rows and columns `qid,name,cat,cc,langs,sitelinks,inception,host,social,status,reach,tranco,sources,feed`. Category codes map to `news_agency`, `newspaper`, `online_news`, `magazine`, `tv`, `radio`, and `broadcaster_other`; website status codes map to `unknown`, `active`, and `inactive`. The index had no inactive entries in this snapshot; it reported 44,753 active website checks and 12,103 unknown checks.

The candidate file preserves one canonical host per source domain and emits one association row for every country code attached to that host. The full index has 48,758 nonempty unique hosts. The released country-coded subset contains 42,965 hosts in 43,506 host-country association rows across 216 country codes, before the root normalizer quarantines malformed or unsupported addresses. Host collisions are deduplicated; `same_host_entity_count` is present only when multiple catalog identities collapsed to one host. The catalog can attach one host to multiple countries; those association rows retain `original_country_codes`, because the host must not be counted as an independent outlet in each country without resolving the outlet identity. The compact row values `country_basis: P17_P495; row-level unknown` and `url_basis: host_normalized; HTTPS/path unverified` refer to the limitations described above. Uncoded catalog rows are not assigned to a country in this file. Of the coded associations, 143 country codes have fewer than 50 media-host rows. These are raw discovery counts across all seven media types; they do not establish 50 useful sources in any country.

The static index exports only a hostname, although it states that the source item had an official website. It does not expose the original `P856` scheme or path. For that reason the candidate `url` is a normalized HTTPS root, marked `url_basis: catalog hostname only; HTTPS scheme/path unverified`; it has not been independently fetched. The original [Wikidata item](https://www.wikidata.org/wiki/Wikidata:Data_access) is retained as provenance. The catalog website-check state is carried as catalog-reported metadata, not represented as a current or independent verification. Rows remain `discovered`.

## Europe and Africa availability

Counts below are rows in this media discovery seed after host deduplication and country-association expansion. They include magazines, broadcasters, television and radio outlets as well as newspapers and online news. They are a high-recall starting point for relevance review, not a count of independent editorial owners or useful event sources.

| Country | Code | Candidate host-country rows |
| --- | --- | ---: |
| France | FR | 1,793 |
| Italy | IT | 731 |
| Germany | DE | 1,671 |
| United Kingdom | GB | 1,824 |
| Spain | ES | 1,080 |
| Ukraine | UA | 333 |
| Nigeria | NG | 212 |
| South Africa | ZA | 137 |
| Egypt | EG | 87 |
| Ghana | GH | 50 |
| Morocco | MA | 65 |
| Kenya | KE | 22 |
| Uganda | UG | 32 |
| Benin | BJ | 23 |
| Côte d’Ivoire | CI | 28 |
| Ethiopia | ET | 10 |
| Tanzania | TZ | 12 |
| Democratic Republic of the Congo | CD | 25 |
| Senegal | SN | 12 |
| Rwanda | RW | 19 |
| Cameroon | CM | 10 |
| Mozambique | MZ | 9 |
| Angola | AO | 10 |
| Niger | NE | 5 |
| Mali | ML | 11 |
| Burkina Faso | BF | 22 |
| Zambia | ZM | 3 |
| Zimbabwe | ZW | 13 |

Microstates and small markets are a structural gap in this catalog: several have only a handful of records or none. Sparse catalogs must remain sparse until local publisher or instrument evidence is found. Do not fill a numeric target with extra sections from one newsroom, unrelated sports/entertainment properties, stale titles, international publishers assigned to the event country, or generated endpoint patterns.

## Complementary catalog assessment

- [Media Cloud Directory](https://www.mediacloud.org/media-cloud-directory) reports more than 25,000 media sources and curated country collections for over 100 countries. Its source guide defines publisher country as the publisher’s primary country of publication, usually where its headquarters are located. The directory is deliberately news-focused and excludes general organization websites, so it cannot provide authority, science, infrastructure, and observation-system coverage. The API documentation describes key-based authentication; no account key or API call was used in this research. The public Directory UI remains a useful secondary check, and a future API harvest needs an authorized key and its current limits.
- The community [vandenbroucke/rss-news-list](https://github.com/vandenbroucke/rss-news-list) publishes JSON, XML, CSV and YAML. Its README enumerates 457 feed URLs but only 52 distinct news publishers, with an ISO alpha-3 `src_country` field and an explicit request for provenance when entries are added. This is a small feed-discovery aid, not a country coverage catalog. Its many category feeds must collapse to their publisher lineage before counting.
- [Wikidata Query Service](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service) offers a public SPARQL endpoint and its structured data is CC0. A bounded five-row query for newspaper website and country properties succeeded. Wikidata’s data-access guidance asks users to avoid unnecessary service load and notes that access interfaces may not be stable. Prefer a documented bulk snapshot for routine global refreshes; use targeted queries for gaps or provenance checks, with cache, query bounds, and a declared user agent.

None of these directories resolves content rights. A CC0 directory record licenses the metadata it supplies; it does not grant a publisher’s permission to fetch or retain articles, submit them to a model, display excerpts, or redistribute derivatives.

## Scalable harvesting and admission rules

1. Retain immutable catalog snapshot, row identifier, original country assignment, observed host, metadata source, and row-level access time. Make every transformation reproducible. Keep raw article bodies out of this discovery dataset.
2. Normalize hostnames for deduplication, but preserve identity/lineage evidence. Never count multiple RSS sections, language paths, subsidiaries under one editorial desk, syndication mirrors, or aliases as independent publishers without evidence.
3. Separate source role from source family. A newspaper, a public warning authority, a hospital network, an earthquake observatory, an election monitor, and a satellite instrument publish different evidence. Record what each can establish, its geographic precision, cadence, latency, and known selection bias.
4. Keep publisher jurisdiction, instrument/issuer jurisdiction, report coverage, event location, and event location certainty as separate fields. A source serving a country does not prove that the described event took place there.
5. Use bulk metadata only for discovery. Before enabling an endpoint, visit the publisher’s own terms/API documentation and record access, storage, model-use, display, attribution, and redistribution permissions independently. A working endpoint or public page is not a reuse grant.
6. Prefer structured source outputs with stable native IDs, correction/deletion semantics, and bounded pagination. Do not make a URL template into a discovered feed. Only record actual URLs present in source evidence; generated homepages and endpoint candidates stay explicitly labeled as normalized or unverified.
7. Rank candidates on useful event yield, original reporting, geographic precision, update behavior, source independence, reliability, language coverage, rights clarity, and operating cost. Exclude routine status notices unless they document a consequential, attributable change. Silence is not evidence that an event did not occur.
8. Report verified coverage separately from discovered counts, and publish gaps. A goal of 50 useful sources per country is a coverage target, not a quota; no category or country should be padded to make the table look complete.

The `catalog-candidates.jsonl` records only publisher metadata and provenance URLs from this one discovery layer. All candidate content permissions and operational integration states remain unknown, and no collector or model was run.
