# World Watch

A proposed worldwide OSINT workspace built around a flat world map, with events linked to their original evidence. This repository began as Europe Watch; the runtime still uses that name while the source atlas and product direction expand globally.

The first prototype wasn't useful enough: repetitive fire reports and notices dominated a clunky feed. The project is paused while its coverage and investigation workflow are reconsidered.

[Product vision](docs/VISION.md) · [Source atlas](research/world-atlas) · [194-task backlog](TODO.md) · [Team handoff](docs/HANDOFF.md)

## What to build

Surface unusual changes. Bring related reports into an evolving event that shows what changed, how it is supported and which questions remain open. Connectivity measurements or public imagery should help someone investigate a situation without filling the feed with routine updates.

Keep one map, one compact feed and one reusable detail panel. The [vision](docs/VISION.md) describes proposed investigation flows and the evidence needed to earn broader coverage. The worldwide research target is 50 useful sources per country, with discovered candidates distinguished from verified access and working integrations.

## What exists

Source adapters feed a D1-backed queue. A local Codex worker requests `gpt-6-luna` and submits structured results to a React/MapLibre client. Public-camera and satellite context have separate paths. The effective served model/tier is unconfirmed.

Useful ranking and severity calibration remain unfinished. The brief scheduler can waste a call on an obsolete catch-up window. Read [the handoff](docs/HANDOFF.md) before running a worker. Existing private queues are preserved; collection and analysis remain paused.

## Check a checkout

Use Node.js 24 and npm:

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run build
npm run audit:public
```

Tests use disposable stores and fixtures, with temporary browser servers. They leave collection and inference stopped. The host-sandbox integration probe is opt-in; a default pass doesn't verify live source quality or the inference host.

## Run an empty local app

Create an ignored `.dev.vars` with distinct random values:

```dotenv
EUROPE_WATCH_OWNER_TOKEN=replace-with-a-random-owner-secret
EUROPE_WATCH_COLLECTOR_TOKEN=replace-with-a-different-collector-secret
EUROPE_WATCH_WORKER_TOKEN=replace-with-a-different-worker-secret
```

```sh
chmod 600 .dev.vars
npm run migrate
npm run build
npm run dev -- --local --var STORAGE_PAUSED:0
```

Open `http://127.0.0.1:8787` and sign in with the owner token. The override affects this local process only. Its separate database starts empty. Stop it with Ctrl-C.

[Worker setup](docs/codex.md) and [hosting configuration](deploy/README.md) require operator-owned credentials. Provider manifests under `.openai/` stay ignored. The public checkout excludes private captures and deployment metadata.

## Pick up the work

Start with [AGENTS.md](AGENTS.md). Claim a bounded task from [TODO.md](TODO.md) and follow [CONTRIBUTING.md](CONTRIBUTING.md). [Architecture](docs/architecture.md) maps the implementation; [verification notes](docs/verification.md) explain its limits. [Pause instructions](docs/paused.md) govern any future restart.

Application code is currently `UNLICENSED`; public visibility grants no open-source licence. Dependencies and datasets retain their own terms, including [map and gazetteer attribution](docs/gazetteer.md).
