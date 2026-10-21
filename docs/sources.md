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

Passenger-train circulation and institutional-announcement feeds were disabled after they overwhelmed the feed. Fire/thermal coverage can still dominate. Adding more endpoints without a usefulness test would repeat that failure.

## Admission contract

Before enabling a source, establish its geographic scope, publisher and upstream origin, update semantics, typical latency, reliability, terms, attribution, and separate permissions for access, storage, model use, display and redistribution. Record the specific grant or blocker. Public reachability is not a grant.

Use approved HTTPS origins and bounded response sizes. Do not follow report-supplied URLs automatically or forward application/service credentials to publishers. Conditional requests and checkpoints advance after durable acceptance. Repeated content, boilerplate and unchanged revisions should not create model work.

Use native episode identity where available. Cross-source bundles need evidence of shared event identity and must preserve contradictions and original source links. Reposted material from one origin counts as one reporting lineage. New material facts, corrections and cancellation can require a new analysis; "one call per event" cannot mean freezing the event forever.

Missing geography remains unknown. Municipality centroids are approximate areas, not exact incident coordinates. Planned assemblies, crowd estimates, observed attendance, evacuation orders and measured displacement are distinct observations. Dataset silence does not establish that nothing happened.

Retention and deletion must propagate through source text, derived claims, search, caches, exports and local spools. Dataset permission and personal-data risk must be reviewed before publishing examples. This repository intentionally omits the collected operational corpus.

## Expansion

[The vision](VISION.md) proposes complementary signal families with primary-source references and access limits. [The backlog](../TODO.md) defines pilots and acceptance tests. Candidates remain research until their rights, useful event yield and operating cost are established; no unimplemented connector should appear as live coverage.
