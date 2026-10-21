# Contributing

This is a paused, unfinished prototype. Read [AGENTS.md](AGENTS.md), [the handoff](docs/HANDOFF.md), [the vision](docs/VISION.md) and [TODO.md](TODO.md) first. Public visibility does not supply a code reuse licence; that decision remains with the owner.

Choose a bounded task and state which files or responsibility you own. If several people or agents are working, coordinate changes to shared server/client modules and migrations. Do not revert another contributor's edits or silently expand the task into deployment.

Use Node.js 24, `npm ci`, `npx playwright install chromium`, then `npm run check`, `npm test`, `npm run build` and `npm run audit:public`. Tests use fixtures and disposable stores. Optional live/browser/Codex host checks must be described separately and require the relevant operator authorization.

For a change, explain the problem, expected behaviour, affected paths, validation and remaining limits. Test the failure or user outcome, not a copy of the implementation. A source adapter needs synthetic fixtures, rights/attribution notes, native identity/update semantics and a real usefulness evaluation before being called live.

Do not commit provider manifests, credentials, raw source captures, runtime state, screenshots of private data or operational database exports. Use `.env.example` and safe generic configuration examples. Publish only reviewed evidence that can be redistributed.

Keep the project paused unless the owner explicitly resumes it. No model calls, schedule activation, supervisor installation, paid fallback or deployment is implied by a source change. See [pause and resume](docs/paused.md).
