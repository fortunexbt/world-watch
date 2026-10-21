# Paused operation

The owner paused this project on 21 October 2026. Repository cleanup and public publication do not authorize resuming it.

At shutdown, the dedicated local launchd worker was stopped and persistently disabled. The remote collector's schedules were emptied and its explicit pause guard was deployed. Queued work, local spools, the budget ledger and private configuration were preserved. The hosted private application and database were retained. These are shutdown observations, not a continuously refreshed service-health report.

## Before any future restart

1. Obtain an explicit decision to resume and identify the intended environment. Do not point a fresh clone at somebody else's deployment.
2. Inventory that environment's supervisor, schedules, durable jobs and unsent spools. Back up state before migrations or queue changes.
3. Address the obsolete bootstrap brief bug in `src/server/brief.ts`; require a regression that counts model calls.
4. Review source usefulness and current access/reuse terms. Disable low-value feeds through an audited policy change; do not delete queued work silently.
5. Supply distinct scoped application credentials. Provision hosting metadata locally, keeping `.openai/` ignored. Never copy subscription auth into deployments or source.
6. Run checks and disposable recovery tests. On the actual inference host, verify supported sign-in and isolation before any model work.
7. Set request/token ceilings, retention and storage limits. Verify old work can be recovered after quota interruption without a catch-up storm.
8. Start one worker under one supervisor. Re-enable collection separately and verify an actual scheduled cycle. An installed schedule is not proof of execution.
9. Observe useful source-to-map events and an operator investigation before expanding coverage.

Preserve state during pauses. Do not clear spools, recreate databases, drop leases or rotate away a credential needed for recovery as a shortcut. Any destructive retention or migration needs a scoped plan and a tested restore path.
