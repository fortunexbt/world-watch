# Deployment configuration

The project is paused and has no supported public production deployment recipe yet. These files are configuration starting points for an operator-owned environment.

- `wrangler.jsonc`: local backend/assets/D1 configuration. Replace placeholder bindings only for your own environment. The shipped storage pause is intentional.
- `collector.wrangler.jsonc`: remote dispatcher, with an explicit pause flag and empty cron schedules. Keep them until a deliberate restart decision.
- `migrations/`: Cloudflare D1 migrations. `drizzle/` at the repository root is the separate Sites schema path.
- `launchd.europe-watch.plist`: local supervisor template with paths to be supplied.
- `remote-worker-entrypoint.mjs`, root Docker/Compose files: optional, unverified separate-host inference path.

For local use, follow [the README](../README.md). For a fresh deployment, provision a private database, distinct scoped secrets and a correct application origin. Do not run remote migrations or deployment commands against an unidentified existing resource. Review [the handoff](../docs/HANDOFF.md) and [pause boundaries](../docs/paused.md) first.

A Sites package requires an operator-provisioned `.openai/hosting.json`. This manifest is local metadata and must remain ignored, including generated copies in `dist/`. The build script must fail clearly when it is missing. This repository supplies no owner project ID, service credential or hosted data.

Deployment acceptance must include anonymous/private-route checks, scoped-credential denial tests, a completed source-to-map event, actual scheduled execution, quota interruption, deletion propagation and backup restore. A successful upload is insufficient. Free hosting has finite quotas; no continuous zero-cost service guarantee has been established.
