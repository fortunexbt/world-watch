# Worldwide source atlas

Research target: at least 50 useful sources per country before worldwide runtime expansion. **This target has not been met.** The core manifest uses 193 UN member states plus the two observer states (195; 9,750 country-source memberships). Territories and other areas can be retained separately. This is a monitoring scope convention, not a sovereignty assessment.

The atlas is a **discovery catalogue**. It does not enable application collection, establish useful event coverage or grant access to publisher content. The app stays paused.

## Current result

The merged research inventory has 43,211 distinct hosts, including 11,108 news or curated specialist candidates. Another 32,103 general-media hosts stay review-only. At the discovery stage, 36 of the 195 target countries have at least 50 news/specialist candidates; 159 remain below that count. Nine malformed or unsupported catalogue addresses are quarantined. None of these counts establishes 50 useful verified sources in any country.

The curated contributions contain 396 records across 41 country memberships before host deduplication. They add regional original reporting and specialist institutions to the bulk publisher catalogue. See the generated coverage table for the authoritative per-country numbers.

## Research lanes

Three GPT-6 Luna agents were explicitly requested for parallel research. Each received a compact standalone brief rather than the application conversation/history. Their owned inputs are:

| Input                                                                | Purpose                                            |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| `catalog-candidates.jsonl`, [FOUNDATION.md](FOUNDATION.md)           | Bulk publisher discovery and catalogue limitations |
| `asia-oceania.jsonl`, [Asia/Oceania notes](asia-oceania.md)          | Curated regional sources                           |
| `americas-africa.jsonl`, [Americas/Africa notes](americas-africa.md) | Curated regional sources                           |

A bulk entry is a website associated with an outlet, often from Wikidata. Radio stations, magazines, inactive sites and historical mistakes can appear in a media directory. A candidate needs a usefulness review. Country attribution generally describes a publisher or source, not everything it covers or where a current event occurred. A normalised HTTPS homepage from a catalogue host is an unverified candidate URL; it is not a discovered working API/feed endpoint.

## Build the inventory

```sh
npm run atlas:check
npm run atlas:build
```

Both commands operate on local metadata only. `scripts/atlas.mjs` groups common hosts, retains country memberships and provenance, and generates an ignored merged `sources.jsonl` plus `coverage.json` and [COVERAGE.md](COVERAGE.md). It does not fetch publishers, run models, alter the source registry or start a service.

The normalizer conservatively groups a host regardless of feed paths. This limits easy inflation, but it is not full publisher/entity resolution: shared platforms can contain different outlets, and a network can operate many hosts. Reporting-lineage independence remains unknown until reviewed. A multinational source may have multiple memberships; it still counts once in the worldwide host total.

`access_verified`, `rights_approved` and `live_integrations` are zero for these newly researched candidates. Metadata retrieval from a catalogue is not a publisher-access check. The published coverage table counts news-agency/newspaper/online-news leads and curated specialist sources toward its research target. Bulk magazines, radio and television stay in a separate review-only column. These categories still need usefulness review. The table shows the remaining discovery shortfall; meeting that numeric count does not satisfy the useful-source gate.

## Admission into the product

For each proposed country pack, review usefulness, source family, original reporting, geographic scope, update cadence, language, native event identity and correction paths. Verify access and separate permissions for storage, model processing, display and redistribution. An open catalogue's licence covers its metadata, not every linked website's content.

Balance local original reporting with domain-specific measurements and relevant public authorities. Routine administrative and passenger notices should not enter the analysis queue. Global instruments can complement local gaps only where actual coverage is established; do not duplicate the same provider 50 times under different layers.

The per-country target can expose genuine scarcity, especially in small states. Keep those shortfalls visible. Do not invent URLs or assign neighbouring publishers to a country as domestic sources just to clear the number.

See [the global work packages](../../TODO.md#worldwide-expansion-gate-new-owner-direction), [the product vision](../../docs/VISION.md), and the catalogue-specific attribution in FOUNDATION.md. App sources and newly discovered candidates remain separate.

## Bounded transport checks

`node scripts/atlas-access.mjs --self-test` checks the URL/DNS guard without network access. `node scripts/atlas-access.mjs --run` performs up to four concurrent credential-free HEAD requests against the explicitly curated URLs, with public-address DNS pinning, limited redirects and timeouts. It reads no article bodies and is a separate deliberate research action, outside ordinary tests. `access-checks.jsonl` and `access-summary.json` record this narrow result. A HEAD success establishes neither a working feed nor useful, licensed content; a denied HEAD is not proof that a permitted browser/API path is unavailable.
