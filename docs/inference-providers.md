# Inference providers

This page records which hosted LLM APIs could classify World Watch inputs at no charge, and which local servers the worker can use. Inputs are public news headlines, their discovery metadata and short public-source records. Output is the structured extraction contract in `src/worker/wire.ts`, validated on the host.

Every hosted figure below was read from the provider's own documentation on 2026-10-23. Limits and terms change often: re-check the cited pages before relying on them. A figure marked "unverified" could not be read from an official page and is not a published limit.

Usage rule: one owner account per provider, used within that provider's published limits. No extra accounts, projects or workspaces to multiply quota, no key rotation and nothing else that evades quotas or terms. Several providers forbid this outright (OpenRouter Terms s. 7, LLM7 Terms s. 3 and s. 5), and Gemini, Groq, Cerebras and Mistral apply limits per project, organization or workspace. Keys come only from environment variables at run time; none is committed or created by this repository.

## Summary

| Provider                         | Verdict             | Free limits (headline)                                                            | Training or review on free tier                                                   | Commercial use                                                                        | OpenAI-compatible base URL                                         | Structured output                                                                              |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Groq                             | Usable              | `openai/gpt-oss-120b`: 30 RPM, 1K RPD, 8K TPM, 200K TPD (see note on plan labels) | No training without permission; logs kept up to 30 days for reliability and abuse | Yes (Services Agreement)                                                              | `https://api.groq.com/openai/v1`                                   | `json_schema` (strict on some models), `json_object`                                           |
| Cloudflare Workers AI            | Usable              | 10,000 Neurons/day; 300 RPM for text generation                                   | Not used for training                                                             | No restriction found                                                                  | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` | `json_schema`, `json_object` on listed models (through the OpenAI-compatible path: unverified) |
| Google Gemini API                | Usable with caveats | Not published in docs (AI Studio only): unverified                                | Yes: used to improve products; human review                                       | Yes, but the free tier cannot serve users in the EEA, UK or Switzerland               | `https://generativelanguage.googleapis.com/v1beta/openai/`         | JSON schema through the OpenAI layer                                                           |
| OpenRouter `:free`               | Usable with caveats | 20 RPM; 50 RPD (under 10 credits bought), 1,000 RPD (10 or more)                  | Depends on the upstream provider; some may train                                  | Yes (DPA applies)                                                                     | `https://openrouter.ai/api/v1` (unverified on fetched pages)       | `json_schema` per endpoint                                                                     |
| SambaNova Cloud                  | Usable with caveats | 20 RPM, 20 RPD, 200,000 TPD per model                                             | Content used only to provide the service                                          | Yes; preview models are evaluation only                                               | `https://api.sambanova.ai/v1` (unverified on fetched pages)        | `json_schema` (best effort), `json_object`                                                     |
| Mistral (Free mode)              | Usable with caveats | Not published (Admin Panel only): unverified                                      | Yes by default; opt-out toggle                                                    | Commercial terms apply                                                                | `https://api.mistral.ai/v1`                                        | `json_schema`, `json_object`                                                                   |
| Z.ai                             | Usable with caveats | Flash models priced at $0; rate limits not published                              | API: not used unless you agree; Terms of Use also grant broad rights              | No explicit clause                                                                    | `https://api.z.ai/api/paas/v4`                                     | `json_object` only                                                                             |
| Ollama Cloud                     | Evaluation only     | Unstated starter amount; 1 concurrent request                                     | Never logged or trained on                                                        | Not checked                                                                           | Unverified                                                         | Unverified                                                                                     |
| Scaleway Generative APIs         | Evaluation only     | 1,000,000 tokens (one-off or recurring not stated)                                | Not checked                                                                       | Not checked                                                                           | `https://api.scaleway.ai/v1` (project-scoped variant exists)       | Not checked                                                                                    |
| LLM7.io                          | Not usable          | Free token: 60/min, 250/h, 100K tokens/24 h                                       | Licence to "improve the Service"; training not stated                             | No: education, research and experimentation only                                      | Unverified                                                         | Not checked                                                                                    |
| Cerebras                         | Not usable (trial)  | $5 credit for 30 days; 5 RPM, 1M TPD                                              | Not used for training                                                             | Trial only, "not intended for production use"                                         | `https://api.cerebras.ai/v1`                                       | `json_schema` (strict), `json_object`                                                          |
| Cohere                           | Not usable          | Trial: 20 RPM chat, 1,000 calls/month                                             | Not checked                                                                       | No: trial keys not for production or commercial use                                   | Not checked                                                        | Not checked                                                                                    |
| NVIDIA API Catalog               | Not usable          | Trial credits; RPM unverified                                                     | Yes: prompts and outputs used to improve products and models                      | No: trial, internal testing and evaluation only; no distribution of generated content | `https://integrate.api.nvidia.com/v1` (unverified)                 | Not checked                                                                                    |
| Hugging Face Inference Providers | Not usable          | Free users: no monthly credits                                                    | Provider dependent                                                                | Paid only                                                                             | `https://router.huggingface.co/v1`                                 | `json_schema` (provider dependent)                                                             |
| Together AI                      | Not usable          | No free tier; $15 first purchase                                                  | Not checked                                                                       | Paid only                                                                             | Not checked                                                        | Not checked                                                                                    |
| Fireworks AI                     | Not usable          | 10 RPM without a payment method; no ongoing free credit found                     | Not checked                                                                       | Paid only                                                                             | Unverified                                                         | Not checked                                                                                    |
| Nebius Token Factory             | Not usable          | $1 trial credit for 30 days, card required                                        | Not checked                                                                       | Trial only                                                                            | Unverified                                                         | Not checked                                                                                    |
| DeepInfra                        | Not usable          | No free tier; card or prepayment required                                         | Not checked                                                                       | Paid only                                                                             | Not checked                                                        | Not checked                                                                                    |
| Chutes                           | Not usable          | No free tier                                                                      | Not checked                                                                       | Paid only                                                                             | Not checked                                                        | Not checked                                                                                    |
| GitHub Models                    | Not usable          | Retired 2026-07-30                                                                | n/a                                                                               | n/a                                                                                   | n/a                                                                | n/a                                                                                            |

The practical conclusion: a free hosted tier covers hundreds to low thousands of extraction calls a day per provider, not "immense volume". Two of the usable providers (Gemini free tier, Mistral by default) may train on or have humans review inputs; that is tolerable only because inputs are already public, and it still rules out anything private or personal. Sustained high volume belongs on local or self-hosted models (see [Local servers](#local-servers)), with hosted free tiers as bounded, explicitly listed overflow.

## Groq

Sources (fetched 2026-10-23):

- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/structured-outputs
- https://console.groq.com/docs/your-data
- https://console.groq.com/docs/billing-faqs
- https://console.groq.com/docs/legal/services-agreement (last modified 22 June 2026)

Free limits. Limits apply per organization. Columns are RPM, RPD, TPM, TPD:

| Model                 | RPM | RPD | TPM | TPD  |
| --------------------- | --- | --- | --- | ---- |
| `openai/gpt-oss-120b` | 30  | 1K  | 8K  | 200K |
| `openai/gpt-oss-20b`  | 30  | 1K  | 8K  | 200K |
| `qwen/qwen3.8-27b`    | 30  | 1K  | 8K  | 200K |

The page has "Free Plan Limits" and "Developer Plan Limits" tabs, but its prose calls the visible table "the base limits for the Developer plan". The page's embedded data holds two tables: the values above are in `freeRows`, and `devRows` lists 1K RPM, 500K RPD and 250K TPM for the same models. Treat the table above as the free allowance and confirm it on the organization's own limits page before raising any budget.

Training and review:

- Services Agreement s. 4.2: Groq "is not permitted to use Inputs or Outputs for training or fine-tuning" unless the customer permits it.
- Inference data is not retained by default. Inputs and outputs may be logged for up to 30 days to troubleshoot reliability or investigate abuse. Zero Data Retention can be enabled in Data Controls. Data is stored in GCP in the United States.
- No free-tier-specific rule is stated.

Commercial use: s. 3.1 grants a limited right to use the services, including in customer applications. s. 2 says the services are "not for consumer use". s. 6.3(d)(iii) bars use "in a manner intended to avoid incurring Fees".

Regions: export control and OFAC sanctions (s. 6.3(d)(v)). No country list.

Endpoint: `https://api.groq.com/openai/v1`. `json_schema` with `strict: true` on `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and `qwen/qwen3.8-27b`; best effort on those plus `openai/gpt-oss-safeguard-20b`. `json_object` is also supported.

Verdict: usable. An ongoing free plan with constrained structured output and a no-training clause. 8K TPM and 200K TPD are the binding limits: at roughly 3K to 6K tokens per extraction call, that is one call every 25 to 45 seconds and roughly 30 to 65 calls a day.

## Cloudflare Workers AI

Sources (fetched 2026-10-23):

- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/limits/
- https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- https://developers.cloudflare.com/workers-ai/features/json-mode/
- https://developers.cloudflare.com/workers-ai/platform/privacy/

Free limits: 10,000 Neurons per day at no charge on both Workers Free and Workers Paid (Paid is billed at $0.011 per 1,000 Neurons above that). Text generation is limited to 300 requests per minute unless the model requires Workers Paid. No RPD, TPM or TPD caps are published.

Neuron cost per million tokens:

| Model                                          | Input  | Output  |
| ---------------------------------------------- | ------ | ------- |
| `@cf/meta/llama-3.1-8b-instruct`               | 25,608 | 75,147  |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast`     | 26,668 | 204,805 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 31,876 | 50,488  |
| `@cf/qwen/qwen3.8-27b`                         | 40,909 | 290,909 |

Derived estimate, not published: one extraction call of 3,000 input and 1,500 output tokens costs about 387 Neurons on `llama-3.3-70b-instruct-fp8-fast`, so about 25 calls a day; on `llama-3.1-8b-instruct` about 190 Neurons, so about 50 calls a day.

Training and review: "Cloudflare does not use Customer Content processed by Workers AI to train AI models." Inputs and outputs are not kept past the request unless storage features or AI Gateway logging are used.

Commercial use and regions: no restriction found on the fetched pages.

Endpoint: `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`. JSON Mode accepts `response_format` with `json_object` or `json_schema` on `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/meta/llama-3.1-8b-instruct`, `@cf/meta/llama-3-8b-instruct`, `@hf/nousresearch/hermes-2-pro-mistral-7b`, `@hf/thebloke/deepseek-coder-6.7b-instruct-awq` and `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`. Schema adherence is not guaranteed, and the docs do not say whether JSON Mode works through the OpenAI-compatible path; configure `structured_output: "none"` until that is checked.

Verdict: usable. Ongoing daily allocation and no training. The Neuron cap is small, and Neurons are not tokens: the worker's token limits cannot express it, so set a conservative `rpd`.

## Google Gemini API

Sources (fetched 2026-10-23):

- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/terms
- https://ai.google.dev/gemini-api/docs/available-regions
- https://ai.google.dev/gemini-api/docs/openai
- https://ai.google.dev/gemini-api/docs/models

Free limits: the rate limits page publishes no free-tier RPM, TPM or RPD figures and says to "View your active rate limits in AI Studio". Limits apply "per project, not per API key", and RPD resets at midnight Pacific time. All free-tier numbers are unverified.

Models free of charge (pricing page): `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, Gemini 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite, 3 Flash Preview and Gemma 4. The models page recommends 3.5 Flash-Lite or 3.8 Flash for new projects.

Training and review: the pricing page marks free-tier content "Used to improve our products: Yes" (paid: "No"). The terms say "human reviewers may read, annotate, and process your API input and output" and "Do not submit sensitive, confidential, or personal information to the Unpaid Services". Public-source records that name individuals need care.

Commercial use: the API is for "professional or business purposes"; users must be 18 or older and the app must not be directed at under-18s.

Regions: Canada and the United States are listed. In the EEA, Switzerland or the UK, only Paid Services may be used when making API clients available to users.

Endpoint: `https://generativelanguage.googleapis.com/v1beta/openai/`. The compatibility page documents structured output with a schema. The native API supports a JSON Schema subset; `minLength`, `maxLength` and similar constraints are not enforced, so host validation does the enforcing.

Verdict: usable with caveats. The free tier trains on inputs and allows human review, the limits are unpublished, and it cannot serve EEA, UK or Swiss users.

## OpenRouter (`:free` models)

Sources (fetched 2026-10-23):

- https://openrouter.ai/docs/api/reference/limits
- https://openrouter.ai/docs/faq
- https://openrouter.ai/docs/guides/privacy/provider-logging
- https://openrouter.ai/docs/guides/privacy/data-collection
- https://openrouter.ai/docs/features/structured-outputs
- https://openrouter.ai/terms
- Public model list: https://openrouter.ai/api/v1/models and `/api/v1/models/{id}/endpoints`

Free limits:

| Credits purchased (all time) | RPM | RPD   |
| ---------------------------- | --- | ----- |
| Less than 10                 | 20  | 50    |
| At least 10                  | 20  | 1,000 |

Extra keys or accounts do not raise limits, and Terms s. 7 forbids multiple accounts to bypass limits. The FAQ says free models are "usually not suitable for production use".

Models: 17 `:free` models were listed on 2026-10-23. These advertise `structured_outputs`: `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3.5-super-vl:free`, `xingchen-agi/xing4.0-29b-a4b:free`, `dots-studio/dots-3-note-preview:free` and `liquid/lfm-2.5-2.6b:free`. `google/gemma-4-31b-it:free` and `google/gemma-4-26b-a4b-it:free` advertise `response_format` only; Gemma 4 31B free is served by Google AI Studio.

Training and review: OpenRouter does not store prompts unless you opt in, but Terms s. 6.1 says "Some Models may store or train on your Inputs". Providers that log, or whose policy is unconfirmed, are used only if the training toggle is enabled, with separate settings for free and paid models. Free endpoints served by Google AI Studio fall under Gemini free-tier terms.

Commercial use: allowed under the DPA; reselling API access is barred.

Regions: some models are restricted by country. Using a VPN or proxy to reach them is a material breach (s. 5.7).

Endpoint and structured output: `https://openrouter.ai/api/v1` was not stated on the fetched pages. `json_schema` support is per endpoint; add `"provider": { "require_parameters": true }` to the provider's `request` so routing only uses endpoints that honour it.

Verdict: usable with caveats. 50 RPD is too low without a one-off purchase of 10 credits, upstream data policies vary, and the free model list changes.

## SambaNova Cloud

Sources (fetched 2026-10-23):

- https://docs.sambanova.ai/docs/en/models/rate-limits
- https://docs.sambanova.ai/docs/en/features/function-calling
- https://sambanova.ai/cloud-end-user-license-agreement

Free limits (while no payment method is linked):

| Model                         | RPM | RPD | TPD     |
| ----------------------------- | --- | --- | ------- |
| `DeepSeek-V3.1`               | 20  | 20  | 200,000 |
| `Meta-Llama-3.3-70B-Instruct` | 20  | 20  | 200,000 |
| `gpt-oss-120b`                | 20  | 20  | 200,000 |
| `DeepSeek-V3.2` (preview)     | 20  | 20  | 200,000 |
| `gemma-4-31B-it` (preview)    | 20  | 20  | 200,000 |

Preview models are "intended for evaluation purposes and developer experimentation only, and should not be used in production environments".

Training and review: s. 2.1 processes Customer Content "solely to the extent necessary to provide the Service". s. 5.2 allows use of query logs and usage data (not Customer Content) to improve products. No explicit training clause.

Commercial use: lawful use is allowed; no resale or sublicensing without consent (s. 1.1). Regions: US export law and embargoes (s. 11.10).

Endpoint: the docs use a placeholder base URL, so `https://api.sambanova.ai/v1` is unverified. `json_schema` is accepted but `strict` is best effort ("only `false` is actively enforced"); `json_object` returns an error on invalid JSON.

Verdict: usable with caveats. 20 requests a day per model makes it a small overflow provider; use production models only.

## Mistral (Free mode)

Sources (fetched 2026-10-23):

- https://docs.mistral.ai/admin/user-management-finops/tier
- https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key
- https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models
- https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training
- https://legal.mistral.ai/terms/commercial-terms-of-service (effective 25 September 2026)
- https://docs.mistral.ai/api
- Could not fetch: https://docs.mistral.ai/deployment/laplateforme/tier/ and https://docs.mistral.ai/deployment/ai-studio/tier (both HTTP 404).

Free limits: "Free mode lets you create API keys and use included monthly usage within the limits shown on the Limits page" (Admin Panel). No card is required. Limits are per workspace and per model, as tokens per minute, requests per second and tokens per month. No numbers are published, so all are unverified.

Training and review: in Free mode "we may use your data (input and output) to train our artificial intelligence models. You have the right to opt out of this program at any time." Turn off "Anonymous improvement data" under Admin, Privacy. The commercial terms say Mistral may train on Labs or Preview model traffic even after opt-out.

Commercial use: the commercial terms govern API use and do not mention a free plan; Labs and Preview models are professional use only. Regions: no use involving EU, US or Singapore comprehensively sanctioned countries or regions (s. 14.13).

Endpoint: `https://api.mistral.ai/v1`. `response_format` accepts `text`, `json_object` and `json_schema`.

Verdict: usable with caveats. Opt out of training before first use, avoid Labs and Preview models, and read the actual limits from the Admin Panel.

## Z.ai

Sources (fetched 2026-10-23): https://docs.z.ai/guides/overview/pricing, https://docs.z.ai/api-reference/llm/chat-completion, https://docs.z.ai/legal-agreement/terms-of-use

GLM-4.7-Flash, GLM-4.5-Flash and GLM-4.6V-Flash are priced at $0; no rate limits are published. Terms s. IV.7 (API users): "we will not use your User Content for developing or improving Services unless you explicitly agree", but s. IV.3(a) grants use of non-personal User Content for AI development and storage outside your jurisdiction. No explicit commercial clause. Not for use from Iran, North Korea, Cuba, Crimea, Donetsk or Zaporizhzhia (s. X.3). Endpoint `https://api.z.ai/api/paas/v4`; `response_format` accepts `text` and `json_object` only.

Verdict: usable with caveats. Unpublished limits and conflicting terms; schema enforcement is host-only.

## Evaluation-only and unusable providers

- Ollama Cloud (https://ollama.com/pricing): a monthly "starter amount of usage for a smaller set of starter models", amount not stated, 1 concurrent request; "Prompt or response data is never logged or trained on." Evaluation only.
- Scaleway Generative APIs (https://www.scaleway.com/en/docs/generative-apis/faq/): up to 1,000,000 tokens, applied to the most expensive tokens first and split across projects; whether it resets is not stated. Evaluation only.
- LLM7.io (https://docs.llm7.io/limits, https://github.com/chigwell/llm7.io/blob/main/TERMS.md): 60 requests per minute, 250 per hour, 100,000 tokens per 24 hours, but "intended for education, experimentation, development, and research". Not usable.
- Cerebras (https://inference-docs.cerebras.ai/support/rate-limits, https://www.cerebras.ai/pricing, https://www.cerebras.ai/terms-of-service): a $5, 30-day trial after adding a payment method; 5 RPM, 1M tokens per day; "not intended for production use". No training on Service Content. Evaluation only.
- Cohere (https://docs.cohere.com/docs/rate-limits, https://cohere.com/pricing): trial keys "are not permitted to be used for production or commercial purposes". Not usable.
- NVIDIA API Catalog (https://docs.api.nvidia.com/nim/docs/api-quickstart, NVIDIA API Trial Terms of Service): trial use "without use of the API Service or Generated Content in production" (s. 1.2), collection of user and generated content to improve models (s. 3.3(iv)) and no distribution of generated content (s. 4.2). Not usable for a public map.
- Hugging Face Inference Providers (https://huggingface.co/docs/inference-providers/pricing): free users get no monthly credits. Not usable.
- Together AI (https://docs.together.ai/docs/billing-credits): "does not currently offer free trials". Not usable.
- Fireworks AI, Nebius Token Factory, DeepInfra, Chutes (https://docs.fireworks.ai/guides/quotas_usage/rate-limits, https://docs.tokenfactory.nebius.com/other-capabilities/billing-new, https://deepinfra.com/pricing, https://chutes.ai/pricing): paid or card-backed trial only. Not usable.
- GitHub Models (https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models): "As of July 30, 2026, GitHub Models has been fully retired." Not usable.

## Local servers

A local server is an OpenAI-compatible endpoint like any other provider, with no quota and no data leaving the machine. When no explicit configuration exists, the worker probes these default loopback ports (never the LAN) with `GET /v1/models` and an 800 ms timeout, in this order, and uses the first server that serves one unambiguous model:

| Order | Server                     | Default           | Source                                                                                                                                                         | Structured output used                                                             | Loaded-model signal                                                     |
| ----- | -------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1     | llama.cpp `llama-server`   | `127.0.0.1:9931`  | `llama-server --help` (version 0.7.0, build 11669): "port to listen (default: 9931)"; https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | `json_schema` (grammar-constrained)                                                | single model, or router `status.value == "loaded"`                      |
| 2     | `mlx_lm.server` or LocalAI | `127.0.0.1:8080`  | `mlx_lm.server --help` (mlx-lm 0.31.1): "Port for the HTTP server (default: 8080)"; https://localai.io/docs/basics/getting_started/                            | none (mlx-lm 0.31.1 has no `response_format`)                                      | exactly one listed model (mlx-lm lists every cached Hugging Face model) |
| 3     | LM Studio                  | `127.0.0.1:1234`  | `~/.lmstudio/.internal/http-server-config.json` (`"port": 1234`); https://lmstudio.ai/docs/developer/openai-compat                                             | `json_schema` (https://lmstudio.ai/docs/developer/openai-compat/structured-output) | `GET /api/v0/models`, `state == "loaded"`, type `llm` or `vlm`          |
| 4     | Ollama                     | `127.0.0.1:11434` | https://docs.ollama.com/api/openai-compatibility                                                                                                               | `json_object` (JSON mode is documented; `json_schema` is not)                      | `GET /api/ps`                                                           |
| 5     | vLLM                       | `127.0.0.1:8000`  | https://docs.vllm.ai/en/latest/cli/serve/ ("Default: 8000"); https://docs.vllm.ai/en/latest/features/structured_outputs/                                       | `json_schema`                                                                      | exactly one listed model                                                |
| 6     | Jan                        | `127.0.0.1:1337`  | https://docs.jan.ai/desktop/api-server                                                                                                                         | none                                                                               | exactly one listed model                                                |
| 7     | text-generation-webui      | `127.0.0.1:5000`  | https://github.com/oobabooga/text-generation-webui/wiki/12-%E2%80%90-OpenAI-API (`--api`, "5000 by default")                                                   | none                                                                               | exactly one listed model                                                |

Notes:

- Port 8080 is shared by `mlx_lm.server` and LocalAI, and older llama.cpp builds also defaulted to it, so the run records it as `local-mlx-lm-or-localai`. The run's `actual_model` comes from the server's own response.
- On macOS, port 5000 is often taken by the AirPlay receiver (ControlCenter). It does not answer `/v1/models` with a model list, so detection skips it.
- A server that lists several models and has no loaded-model signal is skipped and logged with `several_models_set_EW_LOCAL_MODEL`. Detection never guesses. Set `EW_LOCAL_MODEL` to the exact model id to choose one; only servers that list it qualify.
- LM Studio with just-in-time loading answers even with no model loaded; it is then skipped as `no_loaded_model` rather than triggering a load.
- Detection runs once per worker process, so the model never changes mid-batch. Start the server with reasoning disabled (for example `llama-server --reasoning off`) for extraction; a thinking model spends its output budget before the JSON.

## Configuring the worker

`EW_ANALYSIS_BACKEND` selects the transport: `codex` (default, unchanged) or `chat`. With `chat`:

1. If `EW_INFERENCE_CONFIG` names a JSON file, its ordered `providers` list is used and nothing is probed.
2. Otherwise the worker detects one local server as described above, or stops with `no_local_inference_server_detected`.

Example configuration, with the limits published on 2026-10-23 as defaults. Check each provider's current page and the account's own limits page before use; Gemini and Mistral are left out because their free limits are unpublished.

```json
{
  "providers": [
    {
      "id": "local",
      "base_url": "http://127.0.0.1:9931/v1",
      "model": "Qwen3-14B-Q4_K_M",
      "structured_output": "json_schema"
    },
    {
      "id": "groq",
      "base_url": "https://api.groq.com/openai/v1",
      "model": "openai/gpt-oss-120b",
      "api_key_env": "GROQ_API_KEY",
      "structured_output": "json_schema",
      "max_output_tokens": 4000,
      "limits": { "rpm": 30, "rpd": 1000, "tpm": 8000, "tpd": 200000 },
      "request": { "reasoning_effort": "low" }
    },
    {
      "id": "sambanova",
      "base_url": "https://api.sambanova.ai/v1",
      "model": "Meta-Llama-3.3-70B-Instruct",
      "api_key_env": "SAMBANOVA_API_KEY",
      "structured_output": "json_object",
      "max_output_tokens": 4000,
      "limits": { "rpm": 20, "rpd": 20, "tpd": 200000 }
    }
  ]
}
```

Fields:

- `id`: names the provider in every `ModelRun` and the ledger file `provider-<id>.json` in the worker spool.
- `base_url`: HTTPS, or plain HTTP on loopback only. Requests never follow redirects, so a key cannot be forwarded to another host.
- `api_key_env`: the name of the environment variable that holds the key. A missing variable stops the worker with an `auth` error.
- `structured_output`: `json_schema` also sends the wire schema as `response_format` with `strict: true`; `json_object` asks for JSON mode; `none` relies on the instructions. The schema is always appended to the instructions as well, because grammar-constrained servers enforce it without showing it to the model (see [Local evaluation](#local-evaluation)). Host validation (`validateResult`, severity grounding, evidence membership) runs on every result in all three modes.
- `max_output_tokens`: default 8192. Counted with the prompt in each token reservation, so it must fit under `tpm`. Smaller batches (`EW_BATCH_SIZE`) keep output short.
- `limits`: `rpm`, `rpd`, `tpm` and `tpd`, with tokens counting input plus output. Omitted limits are not enforced locally. Days are UTC days; a provider that resets at another time (Gemini resets at midnight Pacific) is caught by its own 429.
- `request`: provider-specific body fields, such as `reasoning_effort`, `service_tier` or OpenRouter's `provider` routing. They override the defaults (`temperature: 0`).

Behaviour:

- The per-minute limits pace requests: the worker waits for the window. A day's limits, a 429 whose `Retry-After` exceeds 60 seconds, or more than three 429 retries move the invocation to the next listed provider. Each move is recorded in the run's `switches`, and exhausting the list stops the worker with a `quota` error, which keeps the queued work.
- Authentication, unknown model, rejected request and transport errors never move to another provider. They stop the invocation so the operator can fix the configuration.
- Each `ModelRun` records `provider`, `endpoint`, `requested_model`, the provider-reported `actual_model` (null when the response does not state one) and the provider's `usage`. A split batch records the run that produced each result.
- The existing local `DailyBudget` still applies across all providers.
- The server publishes chat-completions results only for `provider/model` pairs listed in its `ACCEPTED_ANALYSIS_MODELS` setting, for example `local/Qwen3-14B-Q4_K_M,groq/openai/gpt-oss-120b`. Codex runs are accepted only for `gpt-6-luna`, as before.
- Briefs stay on Codex. A worker on the chat backend leaves brief windows queued.

## Local evaluation

On 2026-10-23 the eight isolated fixtures in `src/worker/eval.ts` ran as one batch through the chat backend against `llama-server` 0.7.0 (build 11669) on an Apple M4 with 24 GiB, detected automatically on its default port. The model was the official `Qwen/Qwen3-14B-GGUF` file `Qwen3-14B-Q4_K_M.gguf` (9.0 GB, SHA-256 `500a8806…6b81f0` matching the repository's LFS record), started with `--reasoning off -c 16384 -np 1`. It was downloaded for this evaluation because the only complete local LLM weights on the machine were a third-party coding fine-tune; the official Qwen3.8 27B snapshot was incomplete. Other agents were running heavy tests at the same time: load averages were 75 to 91 on 10 cores, so throughput here is a floor, not a benchmark.

Command: `EW_ANALYSIS_BACKEND=chat EW_EVAL_TIMEOUT_MS=1200000 npx tsx src/worker/eval.ts 8`.

| Measure                                                        | Result                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Schema-valid results                                           | 8/8                                                                                                                      |
| Validator rejections                                           | 0 (no `unsupported_escalation`, no evidence or identity rejections)                                                      |
| Relevance agreement                                            | 8/8                                                                                                                      |
| Location agreement (country set and named city)                | 8/8                                                                                                                      |
| Severity agreement (impact within the rubric's allowed levels) | 6/8                                                                                                                      |
| Tool attempts                                                  | 0                                                                                                                        |
| Throughput                                                     | 1.22 reports per minute; 5.6 output tokens per second (2,214 output and 2,414 prompt tokens in 394.5 s)                  |
| Memory                                                         | `llama-server` physical footprint peaked at 3.9 GB, plus the 9.0 GB memory-mapped weights; resident set peaked at 4.8 GB |

Fixture checks: the peaceful march stayed visible and non-violent, the 2019 video produced no event claim, and the correction excluded Madrid. Failures, all semantic and none caught by host validation because each was schema-valid and grounded:

- The Seville access closure was classified as `displacement` with `informational` impact instead of a `disruption` that is `minor` or `unknown`.
- The correction carried no `corrects` relationship.
- Paris and Brussels were one claim with two places, not two claims.
- The ambiguous Frankfurt rally got place uncertainty but `informational` impact and no targeted review; `unknown` and review were expected.
- `impacts` repeated the impact label instead of quoting a source phrase.

A first run without the schema in the prompt (constrained decoding only) was also 8/8 schema-valid, but every claim's activity was `drought`: the model began an unlisted word with "d" and the grammar completed it into the only listed value it could reach. The backend now always shows the schema to the model. A second run failed after 300 s because Node's `fetch` stops waiting for response headers after five minutes; the backend now streams responses.

Live headline triage of four synthetic English and Spanish headlines took 161 s (about 950 output tokens). All four were accepted with the expected relevance, categories (strike, wildfire, demonstration) and places, except that "se manifiestan" (present tense) was labelled a planned rather than an ongoing demonstration.

No Luna evaluation results are recorded in the repository, so there is no direct comparison; the README records only zero tool attempts on the malicious-input fixture, which this run also met. The evaluation's per-fixture checks previously looked results up by report id in a map keyed by analysis key, so they always reported missing values; they are now keyed correctly.

Verdict: on this tiny set, Qwen3 14B is adequate for relevance and coarse location triage and inadequate for correction relationships, claim separation, grounded impact phrases and ambiguity review. Eight fixtures are not an accuracy measure. Do not add a local model to `ACCEPTED_ANALYSIS_MODELS` for publication until a labelled corpus (TODO L01) shows acceptable per-category error rates; use it for triage and queue ordering in the meantime.
