import { mkdir, readFile, open, rename } from "node:fs/promises";
import path from "node:path";
type Entry = {
  estimated_input: number;
  actual_input: number | null;
  actual_output: number | null;
};
type State = { day: string; invocations: Record<string, Entry> };
export type Limits = {
  requests: number;
  inputTokens: number;
  reserveRequests: number;
  reserveInputTokens: number;
};
async function saveState(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + process.pid + ".tmp";
  const f = await open(temp, "w", 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, file);
  const d = await open(path.dirname(file), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
async function loadState<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as any).code === "ENOENT") return null;
    throw e;
  }
}
export const configuredLimits = (): Limits => ({
  requests: Number(process.env.EW_DAILY_REQUEST_LIMIT || 100),
  inputTokens: Number(process.env.EW_DAILY_INPUT_TOKEN_LIMIT || 2000000),
  reserveRequests: Number(process.env.EW_OTHER_WORK_REQUEST_RESERVE || 10),
  reserveInputTokens: Number(process.env.EW_OTHER_WORK_INPUT_RESERVE || 200000),
});
export class DailyBudget {
  constructor(
    public file: string,
    public limits: Limits = configuredLimits(),
    private clock: () => Date = () => new Date(),
  ) {
    for (const v of Object.values(limits))
      if (!Number.isSafeInteger(v) || v < 0)
        throw Error("invalid_worker_budget_limit");
  }
  private async state(): Promise<State> {
    const day = this.clock().toISOString().slice(0, 10);
    const s = await loadState<State>(this.file);
    if (!s) return { day, invocations: {} };
    if (
      typeof s.day !== "string" ||
      !s.invocations ||
      typeof s.invocations !== "object"
    )
      throw Error("invalid_daily_budget_state");
    return s.day === day ? s : { day, invocations: {} };
  }
  private summarize(s: State) {
    const entries = Object.values(s.invocations),
      requestLimit = Math.max(
        0,
        this.limits.requests - this.limits.reserveRequests,
      ),
      inputLimit = Math.max(
        0,
        this.limits.inputTokens - this.limits.reserveInputTokens,
      );
    const charged = entries.reduce(
      (n, e) => n + (e.actual_input ?? e.estimated_input),
      0,
    );
    return {
      day: s.day,
      configured: this.limits,
      effective_request_limit: requestLimit,
      effective_input_token_limit: inputLimit,
      requests: entries.length,
      actual_input_tokens: entries.reduce(
        (n, e) => n + (e.actual_input ?? 0),
        0,
      ),
      actual_output_tokens: entries.reduce(
        (n, e) => n + (e.actual_output ?? 0),
        0,
      ),
      unattested_invocations: entries.filter((e) => e.actual_input === null)
        .length,
      estimated_or_actual_input_tokens: charged,
      remaining_requests: Math.max(0, requestLimit - entries.length),
      remaining_input_tokens: Math.max(0, inputLimit - charged),
      subscription_capacity: "unknown",
      max_concurrency: 1,
    };
  }
  async summary() {
    return this.summarize(await this.state());
  }
  async available(minimumInput = 20000) {
    const s = await this.summary();
    return s.remaining_requests > 0 && s.remaining_input_tokens >= minimumInput;
  }
  async reserve(id: string, estimatedInput: number) {
    const s = await this.state();
    if (s.invocations[id]) return;
    const summary = this.summarize(s);
    if (
      summary.remaining_requests < 1 ||
      summary.remaining_input_tokens < estimatedInput
    )
      throw Error("daily_worker_budget_exhausted");
    s.invocations[id] = {
      estimated_input: estimatedInput,
      actual_input: null,
      actual_output: null,
    };
    await saveState(this.file, s);
  }
  async record(id: string, usage: any) {
    const s = await this.state(),
      entry = s.invocations[id];
    if (!entry) return;
    if (Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0)
      entry.actual_input = usage.input_tokens;
    if (Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0)
      entry.actual_output = usage.output_tokens;
    await saveState(this.file, s);
  }
}
/** A provider's published allowance. Tokens count input plus output; an absent limit is not enforced locally. */
export type RateLimits = {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
};
type RateState = {
  entries: Record<string, { at: number; tokens: number }>;
  blocked_until: number;
};
/** Paces one provider within its per-minute and per-UTC-day allowance across restarts. */
export class ProviderBudget {
  constructor(
    public file: string,
    public limits: RateLimits,
    private clock: () => number = Date.now,
  ) {
    for (const v of Object.values(limits))
      if (!Number.isSafeInteger(v) || v < 1)
        throw Error("invalid_provider_limit");
  }
  private async state(now: number): Promise<RateState> {
    const s = (await loadState<RateState>(this.file)) ?? {
      entries: {},
      blocked_until: 0,
    };
    if (!s.entries || typeof s.entries !== "object")
      throw Error("invalid_provider_budget_state");
    const keep = Math.min(dayStart(now), now - 60000);
    for (const [id, e] of Object.entries(s.entries))
      if (e.at < keep) delete s.entries[id];
    return s;
  }
  /** Reserves capacity and returns 0, or returns the milliseconds to wait first. Throws once the day is spent. */
  async reserve(id: string, estimatedTokens: number) {
    const now = this.clock(),
      s = await this.state(now),
      { rpm, rpd, tpm, tpd } = this.limits;
    if (s.entries[id]) return 0;
    const entries = Object.values(s.entries).sort((a, b) => a.at - b.at),
      today = entries.filter((e) => e.at >= dayStart(now)),
      minute = entries.filter((e) => e.at > now - 60000),
      sum = (list: typeof entries) => list.reduce((n, e) => n + e.tokens, 0);
    if (
      (rpd && today.length >= rpd) ||
      (tpd && sum(today) + estimatedTokens > tpd)
    )
      throw Error("provider_daily_limit");
    if (tpm && estimatedTokens > tpm)
      throw Error("request_exceeds_provider_tpm");
    let wait = Math.max(0, s.blocked_until - now);
    if (rpm && minute.length >= rpm)
      wait = Math.max(wait, minute[minute.length - rpm].at + 60000 - now);
    if (tpm) {
      let used = sum(minute);
      for (const e of minute) {
        if (used + estimatedTokens <= tpm) break;
        used -= e.tokens;
        wait = Math.max(wait, e.at + 60000 - now);
      }
    }
    if (wait > 0) return wait;
    s.entries[id] = { at: now, tokens: estimatedTokens };
    await saveState(this.file, s);
    return 0;
  }
  async record(id: string, tokens: number) {
    const s = await this.state(this.clock());
    if (!s.entries[id] || !Number.isSafeInteger(tokens) || tokens < 0) return;
    s.entries[id].tokens = tokens;
    await saveState(this.file, s);
  }
  async block(until: number) {
    const s = await this.state(this.clock());
    s.blocked_until = Math.max(s.blocked_until, until);
    await saveState(this.file, s);
  }
}
function dayStart(now: number) {
  return Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
}
