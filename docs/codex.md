# Local inference

The current worker requests the exact model identifier `gpt-6-luna` through a locally installed supported Codex executable. It requests Fast separately from reasoning effort. The transport records requested configuration; it does not attest the model or service tier actually served. Model access, supported flags and subscription terms must be rechecked on the intended host before restarting.

The project is paused. None of the checks in the root README invoke a model. Running `doctor`, `once`, evaluation or a worker loop may invoke Codex, access credentials and consume account quota; use them only in an authorized inference session.

## Relevant files

| File                       | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `src/worker/adapter.ts`    | Codex process, settings, isolation checks, event parsing |
| `src/worker/analyst.ts`    | Evidence extraction prompt and output contract           |
| `src/worker/wire.ts`       | Compact model-facing input                               |
| `src/worker/brief.ts`      | Brief generation                                         |
| `src/worker/budget.ts`     | Persisted invocation reservations and token accounting   |
| `src/worker/worker.ts`     | Durable queue/spool lifecycle                            |
| `src/worker/supervisor.ts` | Single local supervisor                                  |

Copy `.env.example` to an ignored `.env` only when configuring your own worker. Supply the local executable path, backend origin and worker-scoped token. For private Sites access, set `EW_SITES_ORIGIN` to the exact HTTPS origin separately and use supported service access. Credentials must never be included in source excerpts, model input, diagnostics or URLs.

Keep Codex authentication on its supported host. A separate host needs its own permitted sign-in; do not copy another host's auth store into a container or deployment. The optional container configuration has not established working Linux isolation or always-on execution.

The extraction process is intended to use no tools and consume only supplied evidence. Its isolation checks must pass on the real host. Source text is untrusted even if it contains instructions. Schema-valid output can still be semantically wrong, so a model upgrade or prompt change needs labelled quality evaluation.

## Token policy

Remove repeated boilerplate and unchanged content before analysis. Use one compact evidence bundle per event revision, stable evidence references, a short system prompt and a small structured result. Preserve material contradictions, dates, units and uncertainty. Truncation must be visible and must not remove the only supporting or correcting evidence.

Content hashes and accepted-result reuse can eliminate duplicate work. Revision changes should trigger inference only when meaningful facts change. The observed obsolete-bootstrap brief bug still violates this goal and is a release blocker in the backlog.

Daily request/input ceilings are local allocations. Reservations for failed calls without usage stay charged conservatively; quota exhaustion must preserve queue work. Actual account allowance and unattended availability are unresolved. No automatic paid fallback is enabled.

The OS-sandbox integration test is opt-in with `EW_TEST_CODEX_SANDBOX=1`. It is skipped by the default offline suite. Run it only on an authorized, supported inference host; a default suite pass does not verify that host boundary.
