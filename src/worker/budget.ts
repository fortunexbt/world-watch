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
    try {
      const s = JSON.parse(await readFile(this.file, "utf8")) as State;
      if (
        typeof s.day !== "string" ||
        !s.invocations ||
        typeof s.invocations !== "object"
      )
        throw Error("invalid_daily_budget_state");
      return s.day === day ? s : { day, invocations: {} };
    } catch (e) {
      if ((e as any).code === "ENOENT") return { day, invocations: {} };
      throw e;
    }
  }
  private async save(s: State) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + "." + process.pid + ".tmp";
    const f = await open(temp, "w", 0o600);
    try {
      await f.writeFile(JSON.stringify(s));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, this.file);
    const d = await open(path.dirname(this.file), "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
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
    await this.save(s);
  }
  async record(id: string, usage: any) {
    const s = await this.state(),
      entry = s.invocations[id];
    if (!entry) return;
    if (Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0)
      entry.actual_input = usage.input_tokens;
    if (Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0)
      entry.actual_output = usage.output_tokens;
    await this.save(s);
  }
}
