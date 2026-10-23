# Local inference

The current worker requests the exact model identifier `gpt-6-luna` through a locally installed supported Codex executable. It requests Fast separately from reasoning effort. The transport records requested configuration; it does not attest the model or service tier actually served. Model access, supported flags and subscription terms must be rechecked on the intended host before restarting.

The worker can instead use any OpenAI-compatible chat-completions endpoint, including a local `llama-server`, `mlx_lm.server`, LM Studio or Ollama, with `EW_ANALYSIS_BACKEND=chat`. Configuration, local server detection, per-provider limits and the vetted list of free hosted tiers are in [inference-providers.md](inference-providers.md). Both transports send the same compact wire input and schema, and the host validates every result the same way.

The project is paused. None of the checks in the root README invoke a model. Running `doctor`, `once`, evaluation or a worker loop may invoke Codex, access credentials and consume account quota; use them only in an authorized inference session.

## Relevant files

| File                       | Purpose                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `src/worker/adapter.ts`    | Backend contract, Codex process, isolation checks, result validation             |
| `src/worker/chat.ts`       | Chat-completions backend, provider list, local server detection                  |
| `src/worker/triage.ts`     | Title-only headline triage through the configured backend                        |
| `src/worker/analyst.ts`    | Evidence extraction prompt and output contract                                   |
| `src/worker/wire.ts`       | Compact model-facing input                                                       |
| `src/worker/brief.ts`      | Brief generation                                                                 |
| `src/worker/budget.ts`     | Persisted invocation reservations, token accounting and per-provider rate limits |
| `src/worker/worker.ts`     | Durable queue/spool lifecycle                                                    |
| `src/worker/supervisor.ts` | Single local supervisor                                                          |

Copy `.env.example` to an ignored `.env` only when configuring your own worker. Supply the local executable path, backend origin and worker-scoped token. For private Sites access, set `EW_SITES_ORIGIN` to the exact HTTPS origin separately and use supported service access. Credentials must never be included in source excerpts, model input, diagnostics or URLs.

Keep Codex authentication on its supported host. A separate host needs its own permitted sign-in; do not copy another host's auth store into a container or deployment. The optional container configuration has not established working Linux isolation or always-on execution.

The extraction process is intended to use no tools and consume only supplied evidence. Its isolation checks must pass on the real host. Source text is untrusted even if it contains instructions. Schema-valid output can still be semantically wrong, so a model upgrade or prompt change needs labelled quality evaluation.

## Token policy

Remove repeated boilerplate and unchanged content before analysis. Use one compact evidence bundle per event revision, stable evidence references, a short system prompt and a small structured result. Preserve material contradictions, dates, units and uncertainty. Truncation must be visible and must not remove the only supporting or correcting evidence.

Content hashes and accepted-result reuse can eliminate duplicate work. Revision changes should trigger inference only when meaningful facts change. The observed obsolete-bootstrap brief bug still violates this goal and is a release blocker in the backlog.

Daily request/input ceilings are local allocations. Reservations for failed calls without usage stay charged conservatively; quota exhaustion must preserve queue work. Actual account allowance and unattended availability are unresolved. No automatic paid fallback is enabled: the chat backend uses only the providers listed in its configuration, in order, and records every move between them.

## Headline triage

News discovery (for example GDELT) yields titles, URLs and discovery metadata, not article bodies. Discovery settles nothing about publisher rights, so a discovered item is triaged on its headline alone. Triage only ranks and filters what goes to full extraction; it never creates, updates or publishes an incident.

- Map each record to `{ id, title, url, language, published_at, seen_at }` and call `triageHeadlines(records, { backend, budget, batchSize })` from `src/worker/triage.ts`, or pipe JSON lines to `npm run worker -- triage [file.jsonl]`.
- Deterministic prefilters in `src/worker/prefilter.ts` run first and cost no model call: exact duplicates (SHA-256 of the normalised story text, with short outlet suffixes and live-blog prefixes removed), near duplicates (MinHash over word sets, confirmed by Jaccard of at least 0.75 and identical numbers, so a magnitude 5.1 and a 6.3 earthquake stay apart), language identification (script, distinctive letters and function words; metadata wins when present), and a noise filter that removes an item only when it matches sport, entertainment or market phrasing and contains no event word in any supported language. A duplicate returns `duplicate_of`, the record whose outcome it shares.
- The remaining headlines are packed `batchSize` per call (default 50, at most 100; see the measurements) as `{ i, lang, title }`. The URL, publisher domain, publisher country and other discovery fields are never sent: a publisher's country does not locate the event, and metadata is not a grant to process the article.
- The model returns, per index, `relevant`, a reason `code` (`current_event`, `planned_event`, `warning`, or why not: `no_event`, `figurative`, `sports`, `entertainment`, `business`, `politics`, `opinion`, `historical`), a coarse `category` from the extraction activity list, `places` as named in the headline with an ISO alpha-2 `cc`, and `review`.
- Host validation per item: the schema, relevance agreeing with the code and with a non-null category, no places on an irrelevant item, and each place grounded in the headline text (a shared word stem, so declined forms pass). An ungrounded place is dropped and the item is flagged for review. One bad item is rejected alone; a batch whose output cannot be read is retried in halves, and a single unreadable item is rejected rather than failing the batch. Quota, authentication and transport errors still stop the run so queued work is kept.
- `published_at` stays null unless the source states a publication time. GDELT's `seendate` is a discovery time and goes in `seen_at`.
- A relevant candidate is queued for full extraction through `headlineInput`, as a `title_only` job whose only evidence excerpt is the title, or through a source whose registry rights allow access, storage and AI use of the article text. Body text may be fetched and sent only when the publisher grants it.

Measured throughput and accuracy are in [inference-providers.md](inference-providers.md#headline-triage).

The OS-sandbox integration test is opt-in with `EW_TEST_CODEX_SANDBOX=1`. It is skipped by the default offline suite. Run it only on an authorized, supported inference host; a default suite pass does not verify that host boundary.
