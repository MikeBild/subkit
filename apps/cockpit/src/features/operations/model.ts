import type { components } from "@cli-core/engine-api/openapi";

type Schemas = components["schemas"];
export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

type ExecutionStats = Pick<Schemas["StatsExecutionsResponse"], "groups">;
type LlmStats = Pick<Schemas["StatsLlmResponse"], "groups">;

function series(byTs: Map<string, number>): number[] | null {
  const values = [...byTs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  return values.length >= 2 ? values : null;
}

export function runTrend(stats: ExecutionStats | null | undefined): number[] | null {
  if (!stats) return null;
  const byTs = new Map<string, number>();
  for (const group of stats.groups)
    for (const bucket of group.buckets)
      byTs.set(bucket.ts, (byTs.get(bucket.ts) ?? 0) + bucket.executions);
  return series(byTs);
}

export function successTrend(stats: ExecutionStats | null | undefined): number[] | null {
  if (!stats) return null;
  const succeeded = new Map<string, number>();
  const finished = new Map<string, number>();
  for (const group of stats.groups) {
    const status = group.key.status;
    if (status !== "succeeded" && status !== "failed") continue;
    for (const bucket of group.buckets) {
      finished.set(bucket.ts, (finished.get(bucket.ts) ?? 0) + bucket.executions);
      if (status === "succeeded")
        succeeded.set(bucket.ts, (succeeded.get(bucket.ts) ?? 0) + bucket.executions);
    }
  }
  const rate = new Map<string, number>();
  for (const [ts, total] of finished)
    if (total > 0) rate.set(ts, Math.round(((succeeded.get(ts) ?? 0) / total) * 100));
  return series(rate);
}

export function costTrend(stats: LlmStats | null | undefined): number[] | null {
  if (!stats) return null;
  const byTs = new Map<string, number>();
  for (const group of stats.groups)
    for (const bucket of group.buckets)
      byTs.set(bucket.ts, (byTs.get(bucket.ts) ?? 0) + (bucket.cost?.amount ?? 0));
  return series(byTs);
}

export const CONNECTOR_DOTS_MAX = 12;

export function connectorDots(counts: {
  enabled: number;
  notOk: number;
  needsReauth: number;
}): Tone[] {
  const enabled = Math.max(0, counts.enabled);
  if (enabled === 0) return [];
  const reauth = Math.min(Math.max(0, counts.needsReauth), enabled);
  const limited = Math.min(Math.max(0, counts.notOk - reauth), enabled - reauth);
  const healthy = enabled - reauth - limited;
  const scale = enabled > CONNECTOR_DOTS_MAX ? CONNECTOR_DOTS_MAX / enabled : 1;
  const share = (n: number) => (n > 0 ? Math.max(1, Math.round(n * scale)) : 0);
  const problems = [
    ...Array<Tone>(share(limited)).fill("warning"),
    ...Array<Tone>(share(reauth)).fill("danger"),
  ].slice(-CONNECTOR_DOTS_MAX);
  const room = CONNECTOR_DOTS_MAX - problems.length;
  return [...Array<Tone>(Math.min(share(healthy), room)).fill("success"), ...problems];
}

export type AttentionReason = Schemas["AttentionItem"]["reason"];
export type NeedIcon =
  | "answer"
  | "approval"
  | "expiry"
  | "paused"
  | "failed"
  | "connector"
  | "proposal"
  | "task"
  | "budget"
  | "key"
  | "risk";

const NEED_VISUAL: Record<AttentionReason, { tone: Tone; icon: NeedIcon }> = {
  awaiting_answer: { tone: "info", icon: "answer" },
  execution_authority_required: { tone: "danger", icon: "approval" },
  execution_authority_unavailable: { tone: "danger", icon: "approval" },
  version_awaiting_approval: { tone: "info", icon: "approval" },
  version_needs_repair: { tone: "warning", icon: "failed" },
  approval_expiring: { tone: "warning", icon: "expiry" },
  schedule_auto_paused: { tone: "danger", icon: "paused" },
  scheduler_stale: { tone: "warning", icon: "paused" },
  failing: { tone: "danger", icon: "failed" },
  patch_proposed: { tone: "info", icon: "proposal" },
  needs_reauth: { tone: "danger", icon: "connector" },
  needs_update: { tone: "warning", icon: "connector" },
  degraded: { tone: "warning", icon: "connector" },
  unhealthy: { tone: "danger", icon: "connector" },
  refresh_refused: { tone: "danger", icon: "connector" },
  refresh_failed: { tone: "danger", icon: "connector" },
  expired_no_refresh: { tone: "danger", icon: "connector" },
  secret_unreadable: { tone: "danger", icon: "key" },
  secret_prepared: { tone: "info", icon: "key" },
  skills_proposed: { tone: "info", icon: "proposal" },
  intake_collected: { tone: "info", icon: "proposal" },
  budget_critical: { tone: "danger", icon: "budget" },
  ai_access_missing: { tone: "warning", icon: "key" },
  risk_critical: { tone: "danger", icon: "risk" },
  task_run_failed: { tone: "danger", icon: "failed" },
  task_result_ready: { tone: "info", icon: "task" },
  task_grant_required: { tone: "warning", icon: "task" },
  task_grant_expiring: { tone: "warning", icon: "expiry" },
  task_owner_unavailable: { tone: "danger", icon: "paused" },
  pair_approval_requested: { tone: "info", icon: "approval" },
};

const PAIR_WAITING = { tone: "neutral", icon: "approval" } as const;

export function needVisual(reason: string): { tone: Tone; icon: NeedIcon } {
  if (reason === "pair_approval_waiting") return PAIR_WAITING;
  return (
    (NEED_VISUAL as Record<string, { tone: Tone; icon: NeedIcon }>)[reason] ?? {
      tone: "info",
      icon: "proposal",
    }
  );
}

const LIVE = new Set(["pending", "queued", "running", "waiting", "awaiting_input"]);
const FAILED = new Set(["failed", "timed_out", "error"]);
const STOPPED = new Set(["cancelled", "canceled", "aborted"]);

export function runTone(status: string): Tone {
  if (LIVE.has(status)) return "info";
  if (FAILED.has(status)) return "danger";
  if (STOPPED.has(status)) return "neutral";
  if (status === "succeeded") return "success";
  return "neutral";
}

export function isLiveRun(status: string): boolean {
  return LIVE.has(status);
}

export interface RunGraphStep {
  key: string;
  name: string | null;
  state: "done" | "active" | "pending";
}

const STEP_DONE = new Set(["succeeded", "completed", "skipped"]);

export function runGraphSteps(
  steps: readonly { step_key: string; status: string }[],
  planned: number | null,
  succeeded = false,
): RunGraphStep[] {
  const ran: RunGraphStep[] = steps.map((step, index) => ({
    key: `${index}:${step.step_key}`,
    name: step.step_key,
    state: STEP_DONE.has(step.status) ? "done" : LIVE.has(step.status) ? "active" : "pending",
  }));
  const rest = Math.max(0, (planned ?? 0) - steps.length);
  return [
    ...ran,
    ...Array.from({ length: rest }, (_, index) => ({
      key: `planned:${steps.length + index}`,
      name: null,
      state: succeeded ? ("done" as const) : ("pending" as const),
    })),
  ];
}

export interface RunFailureFacts {
  runId: string;
  stepKey: string | null;
  cause: string | null;
  finishedAt: string | null;
}

export interface RunFailureLabels {
  runId: string;
  step: string;
  code: string;
  finished: string;
}

export function runFailureKind(cause: string | null, status: string): string {
  return cause && cause !== "ok" ? cause : status;
}

export function runFailureRows(
  facts: RunFailureFacts,
  labels: RunFailureLabels,
  when: (iso: string) => string,
): [string, string][] {
  return [
    [labels.runId, facts.runId],
    ...(facts.stepKey ? [[labels.step, facts.stepKey] as [string, string]] : []),
    ...(facts.cause && facts.cause !== "ok"
      ? [[labels.code, facts.cause] as [string, string]]
      : []),
    ...(facts.finishedAt ? [[labels.finished, when(facts.finishedAt)] as [string, string]] : []),
  ];
}

export const DURATION_BARS = 12;

export function durationBars(
  runs: readonly { started_at?: string | null; finished_at?: string | null }[],
): number[] {
  const durations: number[] = [];
  for (const run of runs) {
    if (!run.started_at || !run.finished_at) continue;
    const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
    if (Number.isFinite(ms) && ms >= 0) durations.push(ms);
    if (durations.length === DURATION_BARS) break;
  }
  return durations.reverse();
}

const DAY_MS = 86_400_000;
export const DEFAULT_DATE_DAYS = 30;
export const MAX_RUNS_LIMIT = 10_000;

const noon = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();

export function daysLeft(until: string | null | undefined, now: Date): number | null {
  if (!until) return null;
  const [y, m, d] = until.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.round((noon(new Date(y, m - 1, d)) - noon(now)) / DAY_MS);
}

export function dateInDays(n: number, now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type Validity = "revoked" | "date";

export interface ApprovalLimits {
  validity: Validity;
  until: string;
  maxRuns: number | null;
}

export function approvalLimits(
  current: { valid_until: string | null; max_runs: number | null } | null,
  now: Date,
): ApprovalLimits {
  const fallback = dateInDays(DEFAULT_DATE_DAYS, now);
  if (!current) return { validity: "revoked", until: fallback, maxRuns: null };
  return {
    validity: current.valid_until ? "date" : "revoked",
    until: fallback,
    maxRuns: current.max_runs,
  };
}

export type LimitsProblem = "date_missing" | "date_past" | "runs_invalid";

export function approvalBounds(
  limits: ApprovalLimits,
  now: Date,
):
  | { ok: true; validUntil: string | null; maxRuns: number | null }
  | { ok: false; problem: LimitsProblem } {
  if (
    limits.maxRuns !== null &&
    (!Number.isInteger(limits.maxRuns) || limits.maxRuns < 1 || limits.maxRuns > MAX_RUNS_LIMIT)
  )
    return { ok: false, problem: "runs_invalid" };
  if (limits.validity === "revoked") return { ok: true, validUntil: null, maxRuns: limits.maxRuns };
  const left = daysLeft(limits.until, now);
  if (left === null) return { ok: false, problem: "date_missing" };
  if (left < 0) return { ok: false, problem: "date_past" };
  const [y, m, d] = limits.until.slice(0, 10).split("-").map(Number);
  const end = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 23, 59, 59);
  return { ok: true, validUntil: end.toISOString(), maxRuns: limits.maxRuns };
}

export function limitsProblem(limits: ApprovalLimits, now: Date): LimitsProblem | null {
  const bounds = approvalBounds(limits, now);
  return bounds.ok ? null : bounds.problem;
}

export function localDay(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function grantLimits(
  grant: { valid_until?: string | null; max_runs?: number | null },
  now: Date,
): ApprovalLimits {
  const limits = approvalLimits(
    { valid_until: grant.valid_until ?? null, max_runs: grant.max_runs ?? null },
    now,
  );
  const day = grant.valid_until ? localDay(grant.valid_until) : null;
  return day ? { ...limits, until: day } : limits;
}

export function limitedGrant<E extends string>(
  suggested: { environment: E; valid_from: string },
  limits: ApprovalLimits,
  now: Date,
): {
  environment: E;
  valid_from: string;
  valid_until: string | null;
  max_runs: number | null;
} | null {
  if (!Number.isFinite(Date.parse(suggested.valid_from))) return null;
  const bounds = approvalBounds(limits, now);
  if (!bounds.ok) return null;
  return {
    environment: suggested.environment,
    valid_from: suggested.valid_from,
    valid_until: bounds.validUntil,
    max_runs: bounds.maxRuns,
  };
}

export function renewalSource<
  A extends {
    execution_environment: string;
    revoked_at: string | null;
    created_at: string;
    valid_until: string | null;
    max_runs: number | null;
  },
>(authorities: readonly A[] | null, environment: string): A | null {
  if (!authorities) return null;
  const own = authorities
    .filter((entry) => entry.execution_environment === environment)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return own.find((entry) => entry.revoked_at === null) ?? own[0] ?? null;
}

export function runResultMarkdown(detail: unknown): { text: string; truncated: boolean } | null {
  if (typeof detail !== "object" || detail === null) return null;
  const record = detail as { result_markdown?: unknown; result_markdown_truncated?: unknown };
  if (typeof record.result_markdown !== "string" || record.result_markdown.trim() === "")
    return null;
  return { text: record.result_markdown, truncated: record.result_markdown_truncated === true };
}

const OPERATING_TONE: Record<string, Tone> = {
  active: "success",
  waiting_approval: "warning",
  waiting_connector: "warning",
  unapproved: "warning",
  failing: "danger",
  stopped: "danger",
  repair_required: "danger",
  disabled: "neutral",
};

export function operatingTone(status: string): Tone {
  return OPERATING_TONE[status] ?? "neutral";
}
