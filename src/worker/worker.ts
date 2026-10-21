import { siteServiceHeaders } from "../shared/transport.js";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  rename,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  type Lease,
  type ModelRun,
  type AnalysisResult,
  validateResult,
} from "../shared/contracts.js";
import { DailyBudget } from "./budget.js";
import { analyze, analysisKey, WorkerError, classifyError } from "./adapter.js";
import { runBriefOnce, analyzeBrief, pruneBriefSpools } from "./brief.js";
export function spoolKey(lease: Lease) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: lease.input.contract_version,
        input: lease.input,
      }),
    )
    .digest("hex");
}
export async function saveSpool(dir: string, key: string, value: unknown) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, key + ".json"),
    tmp = target + "." + randomUUID() + ".tmp";
  const f = await open(tmp, "w", 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(tmp, target);
  const d = await open(dir, "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
export function nextIdleDelay(previous: number, claimed: number) {
  return claimed ? 1000 : Math.min(60000, Math.max(15000, previous * 2));
}
export function storageQuotaMessage(message: string) {
  return /storage_quota_paused|daily.*(?:row|read|write).*limit|daily.*limit.*(?:row|read|write)|(?:row|read|write).*daily.*limit|D1.*(?:quota|limit exceeded)|database.*storage.*quota/i.test(
    message,
  );
}
export function quotaResumeAt(retryAfter: string | null, now: number) {
  const seconds =
    retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter)
      : null;
  const explicit =
    seconds === null ? Date.parse(retryAfter || "") : now + seconds * 1000;
  return Number.isFinite(explicit) && explicit > now
    ? explicit
    : Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z") +
        86400000;
}
export function invalidRule(error: string) {
  const known = [
    "unsupported_evidence",
    "invalid_event_time",
    "unsupported_escalation",
    "analysis_identity_mismatch",
    "source_time_mismatch",
    "irrelevant_report_has_claims",
    "duplicate_claim_ids",
    "duplicate_result",
    "missing_result",
    "invalid_result",
  ];
  return (
    known.find((rule) => error === rule || error === "Error: " + rule) ??
    "schema_validation"
  );
}
export function workerHeaders(
  base: string,
  token: string,
  sitesToken?: string,
  sitesOrigin?: string,
): Record<string, string> {
  return {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    ...siteServiceHeaders(base, sitesToken, sitesOrigin),
  };
}
export class RemoteWorker {
  base: string;
  token: string;
  id: string;
  spool: string;
  analyzer: typeof analyze;
  briefAnalyzer: typeof analyzeBrief;
  lastBriefPoll = -Infinity;
  budget: DailyBudget;
  now: () => number;
  lastTombstones = -Infinity;
  lastHeartbeat = -Infinity;
  heartbeatState = "";
  private sitesToken?: string;
  private sitesOrigin?: string;
  constructor(opts: {
    base: string;
    token: string;
    id: string;
    spool: string;
    analyzer?: typeof analyze;
    briefAnalyzer?: typeof analyzeBrief;
    now?: () => number;
    sitesToken?: string;
    sitesOrigin?: string;
  }) {
    this.base = opts.base.replace(/\/$/, "");
    this.token = opts.token;
    this.id = opts.id;
    this.spool = opts.spool;
    this.analyzer = opts.analyzer ?? analyze;
    this.briefAnalyzer = opts.briefAnalyzer ?? analyzeBrief;
    this.now = opts.now ?? Date.now;
    this.sitesToken = opts.sitesToken ?? process.env.EW_SITES_SERVICE_TOKEN;
    this.sitesOrigin = opts.sitesOrigin ?? process.env.EW_SITES_ORIGIN;
    this.budget = new DailyBudget(path.join(this.spool, "daily-budget.json"));
    if (!this.token) throw Error("EW_WORKER_TOKEN_required");
    if (
      !/^https:\/\//.test(this.base) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(this.base)
    )
      throw Error("remote_worker_requires_https");
  }
  async storagePauseUntil() {
    try {
      const state = JSON.parse(
        await readFile(path.join(this.spool, "storage-circuit.json"), "utf8"),
      );
      return Number.isFinite(state.until) && state.until > this.now()
        ? (state.until as number)
        : 0;
    } catch (e) {
      if ((e as any).code === "ENOENT") return 0;
      throw e;
    }
  }
  async api(route: string, body: unknown) {
    if (await this.storagePauseUntil())
      throw new WorkerError("storage_quota", "storage_quota_paused");
    const res = await fetch(this.base + "/api/worker/" + route, {
      method: "POST",
      headers: workerHeaders(
        this.base,
        this.token,
        this.sitesToken,
        this.sitesOrigin,
      ),
      redirect: "error",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok && storageQuotaMessage(text)) {
      let retryHint: string | null = res.headers.get("retry-after");
      if (!retryHint) {
        try {
          const seconds = JSON.parse(text).retry_after_seconds;
          if (typeof seconds === "number" && seconds > 0)
            retryHint = String(seconds);
        } catch {}
      }
      await saveSpool(this.spool, "storage-circuit", {
        until: quotaResumeAt(retryHint, this.now()),
        reason: "storage_quota_paused",
      });
      throw new WorkerError("storage_quota", "storage_quota_paused");
    }
    if (!res.ok)
      throw new WorkerError(
        res.status === 401
          ? "worker_auth"
          : res.status === 409
            ? "lease"
            : "transport",
        `worker_${route}_${res.status}`,
      );
    return JSON.parse(text);
  }
  async submit(lease: Lease, result: AnalysisResult, run: ModelRun) {
    const response = await this.api("complete", { lease, result, run });
    if (response.accepted !== true)
      throw new WorkerError("lease", "completion_not_accepted");
    return response;
  }
  async recordInvalid(lease: Lease, error: string, run: ModelRun) {
    const file = path.join(this.spool, "invalid-diagnostics.json");
    let records: unknown[] = [];
    try {
      records = JSON.parse(await readFile(file, "utf8")).records || [];
    } catch (e) {
      if ((e as any).code !== "ENOENT") throw e;
    }
    await saveSpool(this.spool, "invalid-diagnostics", {
      records: [
        ...records,
        {
          job_id: lease.job_id,
          report_id: lease.input.report_id,
          content_revision: lease.input.content_revision,
          rule: invalidRule(error),
          run,
        },
      ].slice(-32),
    });
  }
  async syncTombstones(force = false) {
    if (!force && this.now() - this.lastTombstones < 60000)
      return new Set<string>();
    this.lastTombstones = this.now();
    await pruneBriefSpools(this.spool, this.now());
    const deleted = new Set<string>();
    let after: string | undefined;
    do {
      const page = await this.api("tombstones", after ? { after } : {});
      for (const id of page.report_ids ?? []) deleted.add(id);
      after = page.next_after ?? undefined;
    } while (after);
    if (!deleted.size) return deleted;
    await mkdir(this.spool, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.spool)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          await readFile(path.join(this.spool, file), "utf8"),
        );
        if (
          deleted.has(data.result?.report_id) ||
          (Array.isArray(data.report_ids) &&
            data.report_ids.some((id: string) => deleted.has(id)))
        )
          await unlink(path.join(this.spool, file));
        if (file === "invalid-diagnostics.json" && Array.isArray(data.records))
          await saveSpool(this.spool, "invalid-diagnostics", {
            records: data.records.filter((r: any) => !deleted.has(r.report_id)),
          });
      } catch {}
    }
    return deleted;
  }
  async heartbeat(state = "online") {
    if (
      state === this.heartbeatState &&
      this.now() - this.lastHeartbeat < 60000
    )
      return;
    this.lastHeartbeat = this.now();
    this.heartbeatState = state;
    await this.api("heartbeat", {
      worker_id: this.id,
      state,
      details: { budget: await this.budget.summary() },
    });
  }
  async once(limit = 4) {
    await this.syncTombstones();
    if (!(await this.budget.available(6000))) {
      await this.heartbeat("budget");
      throw new WorkerError("budget", "daily_worker_budget_exhausted");
    }
    const { leases } = (await this.api("claim", {
      worker_id: this.id,
      limit: Math.min(12, Math.max(1, limit)),
    })) as { leases: Lease[] };
    if (!leases.length) {
      await this.heartbeat();
      return { claimed: 0, completed: 0, failed: 0 };
    }
    // Claims can arrive during a long idle; refresh deletions before any retained result is used.
    await this.syncTombstones(true);
    let completed = 0,
      failed = 0;
    const held = new Set(leases.map((l) => l.job_id));
    let renewBusy = false;
    const renew = async () => {
      if (renewBusy) return;
      renewBusy = true;
      try {
        for (const l of leases) {
          if (!held.has(l.job_id)) continue;
          try {
            await this.api("renew", {
              job_id: l.job_id,
              attempt_id: l.attempt_id,
              fence: l.fence,
            });
          } catch {
            held.delete(l.job_id);
          }
        }
      } finally {
        renewBusy = false;
      }
    };
    const timer = setInterval(() => void renew(), 15000);
    try {
      const pending: Lease[] = [];
      for (const l of leases) {
        const key = spoolKey(l);
        try {
          const cached = JSON.parse(
            await readFile(path.join(this.spool, key + ".json"), "utf8"),
          );
          const result = validateResult(cached.result, l.input);
          await this.submit(l, result, cached.run);
          held.delete(l.job_id);
          completed++;
          await unlink(path.join(this.spool, key + ".json")).catch(() => {});
        } catch (e) {
          if (e instanceof WorkerError && e.kind === "storage_quota") throw e;
          if (e instanceof WorkerError && e.kind === "lease") {
            held.delete(l.job_id);
            failed++;
          } else pending.push(l);
        }
      }
      if (pending.length) {
        try {
          const result = await this.analyzer(
            pending.map((l) => l.input),
            { budget: this.budget },
          );
          // Persist every completed peer before the first network submission can interrupt the batch.
          for (const l of pending) {
            const good = result.accepted.get(analysisKey(l.input));
            if (good)
              await saveSpool(this.spool, spoolKey(l), {
                result: good,
                run: result.run,
              });
          }
          for (const l of pending) {
            const good = result.accepted.get(analysisKey(l.input));
            if (good) {
              if (!held.has(l.job_id)) {
                failed++;
                continue;
              }
              try {
                await this.submit(l, good, result.run);
                completed++;
                held.delete(l.job_id);
                await unlink(
                  path.join(this.spool, spoolKey(l) + ".json"),
                ).catch(() => {});
              } catch (e) {
                if (e instanceof WorkerError && e.kind === "storage_quota")
                  throw e;
                failed++;
              }
            } else {
              await this.recordInvalid(
                l,
                result.invalid.get(analysisKey(l.input)) || "invalid_result",
                result.run,
              );
              if (held.has(l.job_id))
                await this.api("fail", {
                  lease: l,
                  kind: "invalid",
                  error:
                    result.invalid.get(analysisKey(l.input)) ||
                    "invalid_result",
                });
              held.delete(l.job_id);
              failed++;
            }
          }
        } catch (e) {
          const kind =
            e instanceof WorkerError ? e.kind : classifyError(String(e));
          for (const l of pending) {
            if (held.has(l.job_id))
              await this.api("fail", {
                lease: l,
                kind,
                error: String(e).slice(0, 1600),
              }).catch(() => {});
            held.delete(l.job_id);
            failed++;
          }
          if (
            [
              "auth",
              "worker_auth",
              "quota",
              "model",
              "isolation",
              "budget",
              "storage_quota",
            ].includes(kind)
          )
            throw e;
        }
      }
      await this.heartbeat();
      return { claimed: leases.length, completed, failed };
    } finally {
      clearInterval(timer);
    }
  }
  async briefOnce() {
    return runBriefOnce(this, {
      persist: (key, value) => saveSpool(this.spool, key, value),
      analyzer: this.briefAnalyzer,
      beforeUse: async (reportIds) => {
        const deleted = await this.syncTombstones(true);
        return !reportIds.some((id) => deleted.has(id));
      },
    });
  }
  async run(signal: AbortSignal) {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        if (this.now() - this.lastBriefPoll >= 60000) {
          this.lastBriefPoll = this.now();
          try {
            const brief = await this.briefOnce();
            if (brief.claimed)
              console.log(
                JSON.stringify({ at: new Date().toISOString(), brief }),
              );
          } catch (error) {
            if (
              error instanceof WorkerError &&
              [
                "auth",
                "worker_auth",
                "quota",
                "model",
                "isolation",
                "budget",
                "storage_quota",
              ].includes(error.kind)
            ) {
              if (error.kind === "budget")
                await this.heartbeat("budget").catch(() => {});
              else throw error;
            }
            console.error(
              JSON.stringify({
                at: new Date().toISOString(),
                brief_error: String(error),
              }),
            );
          }
        }
        const r = await this.once(Number(process.env.EW_BATCH_SIZE || 4));
        console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
        delay = nextIdleDelay(delay, r.claimed);
      } catch (e) {
        console.error(
          JSON.stringify({ at: new Date().toISOString(), blocker: String(e) }),
        );
        delay =
          e instanceof WorkerError &&
          [
            "auth",
            "worker_auth",
            "quota",
            "model",
            "isolation",
            "budget",
            "storage_quota",
          ].includes(e.kind)
            ? 300000
            : Math.min(delay * 2, 60000);
        if (e instanceof WorkerError && e.kind === "storage_quota")
          delay = Math.max(1000, (await this.storagePauseUntil()) - this.now());
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, delay);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
