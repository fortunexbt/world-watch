# Operator notes

Start with [paused.md](paused.md). The project is intentionally stopped. These notes explain boundaries for a future authorized local session, not a request to resume services.

Use the root README for disposable local setup. `.dev.vars` contains backend owner/collector/worker secrets. `.env` or a private worker environment contains only the worker's application credential and local configuration. A hosted private Sites connection additionally requires a separately scoped service credential and an exact configured origin. Keep owner credentials away from workers and collectors.

The public source contains no owner deployment configuration. Supply your own database binding, application origin, provider resources and locally provisioned hosting manifest. Do not infer production resource IDs from old commands. See [deployment notes](../deploy/README.md).

## Recovery boundaries

| Failure                                  | Required behaviour                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Host asleep or offline                   | Keep remote jobs and local unsent spools; recover leases on return        |
| Auth, model access or quota interruption | Stop inference with a visible reason and retry delay; preserve jobs       |
| Stale lease or newer revision            | Reject stale completion; do not overwrite the current result              |
| Source outage or finite-feed gap         | Report stale coverage; do not infer resolution or retraction              |
| Database limit                           | Stop costly automatic reads and collection pressure; preserve queue state |
| Rights revocation or deletion            | Purge affected text and derived copies, including worker spools           |

These are intended contracts with fixture coverage for selected cases. A full deployed recovery drill, sustained capacity and restore verification remain backlog work.

The supervisor CLI is in `src/worker/supervisor.ts`. Inspect its `status` command and configured label before installing or starting anything. Use one supervisor, one persistent worker state directory and one inference process. Do not use sleep prevention or spawn competing workers to mask a capacity problem.

Usage ledgers represent application allocations, not remaining account subscription capacity. Unknown provider usage stays unknown. Do not switch to paid billing, another model or copied authentication on failure.

Private execution receipts belong under ignored `work/` storage, with restrictive permissions. Review and redact any evidence before sharing it. Public source changes and private deployment operations are separate actions.
