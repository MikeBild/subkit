// Operator health digest — a deterministic, LLM-free summary of what
// needs a human's attention on a tenant right now.
//
// Two surfaces consume it:
//   * GET /v1/operator/health-digest (this slice) — the `sk` REPL fetches
//     it at startup and renders it as a colored first assistant turn.
//   * the structured payload is injected as conversation context so the
//     LLM can act on the failures (diagnose / approve patches / fix
//     inputs) without re-deriving them.
//
// It groups failed executions by ROOT-CAUSE SIGNATURE — (workflow, step,
// error code) — rather than listing 250 independent rows, tags each
// group by where it came from (authoring trial-run vs manual test vs
// scheduled workflow), and reuses the runtime failure classifier so
// the cause reads like a sentence, not a stack trace. Open patch
// decisions (proposed AND reviewable — `readOpenPatchDecisions`, the one
// predicate every surface counts) ride along as the digest's review list.
//
// What needs a human NOW — the headline, `all_clear`, the "Needs attention"
// lines and the MCP connect instructions — is not decided here. It is rendered
// from `buildAttention` (attention.ts), the one list every surface reads.

import { and, desc, eq, gte, inArray, isNull, max } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { executionSteps, executions, workflows } from "../db/schema/index.ts";
import {
  classifyPersistedFailure,
  humanizeClassification,
  type PreviewClassification,
} from "../execution/classify.ts";
import { classifyRunFailure, pickStoppingStep } from "../execution/outcome.ts";
import { monthlyUsage, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import {
  type AttentionItem,
  type AttentionV1,
  attentionAllClear,
  buildAttention,
} from "./attention.ts";
import { computeRiskSignals, type RiskSignal } from "./risk-signals.ts";

const DEFAULT_WINDOW_HOURS = 24;
const MAX_SCANNED_EXECUTIONS = 500;
/**
 * How far back the decision queue asks "which approved workflows are failing".
 *
 * One constant, because two surfaces answer that question and they used to ask
 * it over different spans: the overview over 24 hours, the queue over seven
 * days. The result was "production incidents: 0" next to a badge counting two
 * of them, with nothing on screen to explain the difference.
 */
export const DECISION_FAILURE_WINDOW_HOURS = 168;
export const MAX_PENDING_PATCHES = 50;
// A proposed patch older than this has sat unreviewed long enough to be an
// operational problem in its own right — a self-healing fix was found but
// never applied, so the underlying workflow keeps failing. An `unsafe` patch
// can only ever leave `proposed` via an explicit human approve/reject, so
// nothing moves it without this surfacing it. We rank stuck patches to the top
// (and never drop them past the cap) so a 4-day-old fix can't hide behind
// fresh noise.
const STUCK_PATCH_DAYS = 3;

/** Where a failed run came from. Authoring trial-runs and manual test
 *  runs are NOT production incidents — the tag keeps them honest. */
export type FailureOrigin = "authoring" | "manual" | "scheduled" | "mixed";

export interface DigestFailureGroup {
  signature: string;
  workflow_id: string | null;
  workflow_name: string | null;
  step_key: string | null;
  error_code: string | null;
  origin: FailureOrigin;
  count: number;
  /**
   * How many of these runs the scheduler started.
   *
   * `origin` cannot answer that once a group holds more than one kind of run:
   * it collapses to `mixed`, which reads the same whether the other runs were
   * manual retries of a failing schedule or an authoring trial that never ran
   * unattended. Filtering on `origin === "scheduled"` therefore dropped a
   * workflow from the decision queue the moment somebody retried it by hand —
   * the schedule kept failing, and the decision left both surfaces at once.
   */
  scheduled_count: number;
  last_seen: string;
  /**
   * The oldest failure of this group inside the window — when the cause
   * started, as far as the window can see. `last_seen` answers "is it still
   * happening"; ordering a queue by it would put the freshest breakage first.
   */
  first_seen: string;
  /** The newest failed run of this group — what a chat about it attaches. */
  latest_execution_id: string;
  /**
   * The connector the stopping step of the newest failed run resolved, when it
   * went through one. What an authentication failure is remedied at.
   */
  connector_id: string | null;
  /**
   * The workflow's most recent clean run on its own schedule, when that run is
   * newer than this group's last failure. Null while the cause is still live.
   *
   * A timestamp rather than a flag, so the arithmetic lives in one place and
   * the row can say WHEN it last ran clean instead of only that it did. Without
   * it a group is counted forever: it knows `last_seen` and nothing about what
   * happened afterwards, so a workflow whose grant was re-issued and which has
   * run clean since kept a decision open with nothing left to decide.
   */
  resolved_at: string | null;
  /** One-sentence human cause, classifier-derived. */
  cause: string;
  /**
   * The classifier's class behind `cause` — the structured half of the same
   * verdict, so a surface can word the cause itself instead of repeating the
   * engine's English sentence.
   */
  cause_class: PreviewClassification;
  /** The connector-authored remediation hint, when the step carried one. */
  guidance: string | null;
}

export interface DigestPatch {
  id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  classification: "safe" | "unsafe";
  /** Whole days the candidate has been in `proposed`. */
  age_days: number;
  /** age_days ≥ STUCK_PATCH_DAYS — surfaced first and flagged for the operator. */
  stuck: boolean;
  summary: string;
}

export interface OperatorHealthDigest {
  generated_at: string;
  window_hours: number;
  /** Outcome-first one-liner for the chat surface. */
  headline: string;
  failure_groups: DigestFailureGroup[];
  /** `open` is the exact count of open patch decisions (proposed AND
   *  reviewable on the current workflow version); `items` is capped at
   *  MAX_PENDING_PATCHES so a backlog can't flood the digest. Every count the
   *  digest prints comes from `open`, never from `items.length`. */
  patch_candidates: { open: number; items: DigestPatch[] };
  /** Leading-indicator risk signals computed from the live process
   *  gauges/counters vs the operator-tuned predictive thresholds. The
   *  failure groups above are lagging (a run already failed); these flag
   *  what is trending toward an incident. Highest-severity first. */
  risk: RiskSignal[];
  /** What needs this reader now — the same list `GET /v1/attention` returns.
   *  The headline, `all_clear` and the rendered decision block come from it. */
  attention: AttentionV1;
  /** Plain-text fallback render; the CLI styles its own from the
   *  structured fields above. */
  rendered: string;
  /** Nothing needs this reader: no attention item, and every source it may
   *  read answered. Failure history and warning trends do not clear it or
   *  block it — they are detail, not something to act on now. */
  all_clear: boolean;
}

function originOf(row: { source_kind: string; request_source: string }): FailureOrigin {
  if (row.source_kind === "draft" || row.source_kind === "step") return "authoring";
  if (row.request_source === "scheduler") return "scheduled";
  return "manual";
}

function mergeOrigin(a: FailureOrigin, b: FailureOrigin): FailureOrigin {
  return a === b ? a : "mixed";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** The connector a persisted step's request metadata names, if it went through one. */
function stepConnectorId(requestMeta: unknown): string | null {
  const id = asRecord(asRecord(requestMeta).connector).connector_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Stamp `resolved_at` on every group whose workflow has since run clean on its
 * own schedule.
 *
 * Only a SCHEDULED success counts. A manual re-run is what an operator does to
 * check whether the fix took, and it proves the workflow can work when driven
 * by hand — not that the thing which fires it unattended has recovered. An
 * authoring trial proves even less.
 *
 * The comparison is `created_at` against `last_seen`, the same column the
 * group's own timestamp comes from: mixing in `finished_at` here is precisely
 * the silent difference that made two surfaces disagree before.
 *
 * One aggregated row per workflow, not a capped list of runs. A capped list
 * ordered by time fills from the global floor forward, so on a busy tenant 500
 * older successes belonging to OTHER workflows evict the one row that proves
 * this workflow recovered — and the query quietly stops resolving anything.
 * `max()` per workflow cannot be crowded out, and the row count is bounded by
 * the number of failing workflows rather than by their traffic.
 */
async function markRecoveredGroups(
  db: Db,
  tenant_id: string,
  groups: DigestFailureGroup[],
): Promise<void> {
  const candidates = groups.filter((group) => group.workflow_id && group.scheduled_count > 0);
  if (!candidates.length) return;
  const workflowIds = [...new Set(candidates.map((group) => group.workflow_id as string))];
  // The earliest failure among them — no success before that can resolve
  // anything, so there is no reason to read one.
  const earliest = candidates.reduce(
    (min, group) => (group.last_seen < min ? group.last_seen : min),
    candidates[0]?.last_seen ?? "",
  );

  const latest = await db
    .select({ workflow_id: executions.workflow_id, at: max(executions.created_at) })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.status, "succeeded"),
        eq(executions.request_source, "scheduler"),
        inArray(executions.workflow_id, workflowIds),
        gte(executions.created_at, new Date(earliest)),
      ),
    )
    .groupBy(executions.workflow_id);

  const latestByWorkflow = new Map(
    latest.flatMap((row) =>
      row.workflow_id && row.at ? [[row.workflow_id, row.at.toISOString()] as const] : [],
    ),
  );
  for (const group of candidates) {
    const at = latestByWorkflow.get(group.workflow_id as string);
    group.resolved_at = at && at > group.last_seen ? at : null;
  }
}

/**
 * The failures of one window, grouped by root cause.
 *
 * Extracted so there is exactly one answer to "which workflows are failing".
 * The overview used to ask it in its own SQL and got a different number than
 * the queue it linked to: a different timestamp column (`finished_at` against
 * `created_at`), a different status set (`timed_out` counted or not) and a
 * different window. Nobody could reconcile them, because reconciling them
 * meant reading two files and noticing three silent differences.
 *
 * Re-deriving this in SQL would mean porting the first-failed-step rule, the
 * origin merge and the scan cap as well — three more places for the same bug.
 */
export async function collectFailureGroups(
  db: Db,
  tenant_id: string,
  windowHours: number,
  generatedAt: Date = new Date(),
): Promise<DigestFailureGroup[]> {
  const cutoff = new Date(generatedAt.getTime() - windowHours * 60 * 60 * 1000);

  const failedExecs = await db
    .select({
      id: executions.id,
      workflow_id: executions.workflow_id,
      source_kind: executions.source_kind,
      source_ref: executions.source_ref,
      request_source: executions.request_source,
      created_at: executions.created_at,
      status: executions.status,
      failure: executions.failure,
    })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.status, "failed"),
        gte(executions.created_at, cutoff),
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(MAX_SCANNED_EXECUTIONS);

  const execIds = failedExecs.map((e) => e.id);
  const failedSteps = execIds.length
    ? await db
        .select({
          execution_id: executionSteps.execution_id,
          step_key: executionSteps.step_key,
          status: executionSteps.status,
          error: executionSteps.error,
          started_at: executionSteps.started_at,
          request_meta: executionSteps.request_meta,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, tenant_id),
            inArray(executionSteps.execution_id, execIds),
            inArray(executionSteps.status, ["failed", "timed_out", "aborted"]),
          ),
        )
    : [];

  // The step that stopped each run — the same rule the execution outcome
  // uses (`pickStoppingStep`), so the digest and a run's own page name the
  // same step: an earlier `on_error:"continue"` failure did not stop anything.
  const rowsByExec = new Map<string, (typeof failedSteps)[number][]>();
  for (const s of failedSteps) {
    const list = rowsByExec.get(s.execution_id) ?? [];
    list.push(s);
    rowsByExec.set(s.execution_id, list);
  }
  const stepByExec = new Map<string, (typeof failedSteps)[number]>();
  for (const exec of failedExecs) {
    const stopping = pickStoppingStep(rowsByExec.get(exec.id) ?? [], exec.failure?.step_id);
    if (stopping) stepByExec.set(exec.id, stopping);
  }

  // Group by root-cause signature.
  const groups = new Map<string, DigestFailureGroup>();
  for (const exec of failedExecs) {
    const step = stepByExec.get(exec.id);
    const classified =
      classifyRunFailure(exec, step ?? null) ??
      classifyPersistedFailure({ status: exec.status, error: null });
    const errorCode = classified.error_code;
    const message = classified.message;
    const guidance = classified.guidance;
    const stepKey = step?.step_key ?? null;
    const wfKey = exec.workflow_id ?? `${exec.source_kind}`;
    const signature = `${wfKey}:${stepKey ?? "-"}:${errorCode ?? "-"}`;
    const origin = originOf(exec);
    const lastSeen = exec.created_at.toISOString();

    const existing = groups.get(signature);
    if (existing) {
      existing.count += 1;
      if (origin === "scheduled") existing.scheduled_count += 1;
      existing.origin = mergeOrigin(existing.origin, origin);
      if (lastSeen > existing.last_seen) existing.last_seen = lastSeen;
      if (lastSeen < existing.first_seen) existing.first_seen = lastSeen;
      continue;
    }

    const cause =
      guidance ??
      humanizeClassification(classified.classification, message, step?.status ?? "step");

    groups.set(signature, {
      signature,
      workflow_id: exec.workflow_id ?? null,
      workflow_name:
        exec.workflow_id === null ? ((asRecord(exec.source_ref).name as string) ?? null) : null,
      step_key: stepKey,
      error_code: errorCode,
      origin,
      count: 1,
      scheduled_count: origin === "scheduled" ? 1 : 0,
      last_seen: lastSeen,
      // Runs are read newest first, so the run that opens a group is its newest.
      first_seen: lastSeen,
      latest_execution_id: exec.id,
      connector_id: stepConnectorId(step?.request_meta),
      resolved_at: null,
      cause,
      cause_class: classified.classification,
      guidance,
    });
  }

  await markRecoveredGroups(db, tenant_id, [...groups.values()]);

  // Resolve workflow names for saved-workflow groups — and drop the groups
  // whose workflow is gone.
  //
  // A deleted workflow kept producing a decision nobody could close: the runs
  // that failed are still in the history, so the group survived its own
  // subject. Deleting the thing is the one remedy always available for "this
  // keeps failing and cannot be fixed here", and it did not work. The same
  // shape as a cause that healed, from the other side: the group knew what
  // failed and nothing about whether the workflow still exists.
  //
  // Soft-deleted, so the history stays readable; it is only the open decision
  // that goes.
  const wfIds = [
    ...new Set([...groups.values()].map((g) => g.workflow_id).filter(Boolean)),
  ] as string[];
  if (wfIds.length) {
    const wfRows = await db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, tenant_id),
          inArray(workflows.id, wfIds),
          isNull(workflows.deleted_at),
        ),
      );
    const nameById = new Map(wfRows.map((r) => [r.id, r.name]));
    for (const [signature, g] of groups) {
      if (!g.workflow_id) continue;
      const name = nameById.get(g.workflow_id);
      if (name === undefined) groups.delete(signature);
      else g.workflow_name = name;
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen),
  );
}

/**
 * The failure groups a human still has to decide about: a workflow that was
 * approved, runs on its schedule, and fails every time. An authoring trial that
 * failed is feedback, not an incident — mixing the two is how a real one ends
 * up buried among experiments.
 *
 * The question is whether the SCHEDULER ever started one of these runs, not
 * whether it started all of them. Asking `origin === "scheduled"` answered the
 * second: one manual retry of a failing scheduled step turned the group
 * `mixed` and the decision disappeared, while the schedule went on failing
 * every hour. Retrying something by hand is what an operator does when it
 * breaks; it must not delete the record that it broke.
 */
export function failingScheduledGroups(
  groups: readonly DigestFailureGroup[],
): DigestFailureGroup[] {
  // `resolved_at` is the second half of the same question. A cause whose
  // workflow has run clean on its schedule since is history, not a decision —
  // counting it left the tile, the badge and the headline all reporting an
  // incident that had already ended, with no way on screen to tell that it had.
  return groups.filter((group) => group.scheduled_count > 0 && group.resolved_at === null);
}

/**
 * The digest for one reader.
 *
 * Its decision block — the headline, `all_clear` and the "Needs attention"
 * lines — is rendered from `buildAttention`, the same list `GET /v1/attention`,
 * `get_attention` and the MCP connect line read. The failure groups, the open
 * patch list and the risk signals stay as the digest's detail: they include
 * what is worth reading (an authoring trial that failed, a warning trend) but
 * is not something a person has to act on now.
 *
 * Read-only. The RISK_SIGNAL_* edge audits are written by the scheduler tick
 * (`scheduler/risk-signal-edges-runner.ts`), never by a read of this digest.
 */
export async function buildOperatorHealthDigest(
  db: Db,
  principal: ResolvedPrincipal,
  opts?: { window_hours?: number },
): Promise<OperatorHealthDigest> {
  const tenant_id = principal.tenant_id;
  const windowHours = opts?.window_hours ?? DEFAULT_WINDOW_HOURS;
  const generatedAt = new Date();
  const [failureGroups, openDecisions, attention] = await Promise.all([
    collectFailureGroups(db, tenant_id, windowHours, generatedAt),
    // Open patch decisions, OLDEST first: a candidate's urgency grows with how
    // long it has sat unreviewed, so when the cap bites it must drop the
    // freshest rows, never the stuck ones. The total is exact and uncapped.
    readOpenPatchDecisions(db, tenant_id, { limit: MAX_PENDING_PATCHES }),
    buildAttention(db, principal, { now: generatedAt }),
  ]);
  const openTotal = openDecisions.open_total;
  const pendingRows = openDecisions.items.map((item) => item.row);

  const patchWfIds = [...new Set(pendingRows.map((r) => r.workflow_id))];
  const patchNameById = patchWfIds.length
    ? new Map(
        (
          await db
            .select({ id: workflows.id, name: workflows.name })
            .from(workflows)
            .where(and(eq(workflows.tenant_id, tenant_id), inArray(workflows.id, patchWfIds)))
        ).map((r) => [r.id, r.name]),
      )
    : new Map<string, string>();

  const patchItems: DigestPatch[] = pendingRows
    .map((r) => {
      const proposal = asRecord(asRecord(r.diff).proposal);
      const ageDays = Math.floor(
        (generatedAt.getTime() - r.created_at.getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        id: r.id,
        workflow_id: r.workflow_id,
        workflow_name: patchNameById.get(r.workflow_id) ?? null,
        classification: r.classification,
        age_days: ageDays,
        stuck: ageDays >= STUCK_PATCH_DAYS,
        summary:
          typeof proposal.description === "string"
            ? proposal.description
            : "Self-healing fix awaiting review",
      };
    })
    // Most-stuck first (oldest age wins; unsafe breaks an age tie since only a
    // human can clear it). This is the operator's review queue order.
    .sort(
      (a, b) =>
        b.age_days - a.age_days ||
        Number(b.classification === "unsafe") - Number(a.classification === "unsafe"),
    );

  // Leading-indicator risks from the live process metrics, plus the month's
  // allowance, which the registry cannot answer: `llm_tokens_total` is a
  // counter since process start and resets on every deploy. The digest holds
  // both halves already, so it hands them over rather than letting the signal
  // guess. Still deterministic for a fixed registry + config + usage snapshot.
  const risk = computeRiskSignals({
    monthTokens: await monthlyUsage(tenant_id, db),
    monthBudget: resolveMonthlyBudget(tenant_id),
  });

  const headline = attentionHeadline(attention);
  const rendered = renderDigest(headline, windowHours, attention, failureGroups, risk);

  return {
    generated_at: generatedAt.toISOString(),
    window_hours: windowHours,
    headline,
    failure_groups: failureGroups,
    patch_candidates: { open: openTotal, items: patchItems },
    risk,
    attention,
    rendered,
    all_clear: attentionAllClear(attention),
  };
}

const CLASS_WORD: Record<AttentionItem["class"], string> = {
  stopped: "stopped",
  failing: "failing",
  decide: "to decide",
};

/**
 * The attention list's one-line summary, in the engine's English — for the
 * `sk` REPL, the MCP connect instructions and the digest. Counts items, never
 * the rows behind them: three proposed fixes on one workflow are one thing to
 * decide.
 */
export function attentionHeadline(attention: AttentionV1): string {
  const failed = Object.entries(attention.sources)
    .filter(([, state]) => state === "failed")
    .map(([source]) => source);
  const unread = failed.length > 0 ? ` Could not read: ${failed.join(", ")}.` : "";
  if (attention.items.length === 0) {
    return failed.length > 0
      ? `Nothing needs your attention in what could be read.${unread}`
      : "All clear — nothing needs your attention.";
  }
  const byClass = (["stopped", "failing", "decide"] as const)
    .map((klass) => [klass, attention.items.filter((item) => item.class === klass).length] as const)
    .filter(([, n]) => n > 0)
    .map(([klass, n]) => `${n} ${CLASS_WORD[klass]}`);
  const n = attention.items.length;
  return `Needs attention: ${n} item${n === 1 ? "" : "s"} (${byClass.join(", ")}).${unread}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line per attention item — subject, machine reason, counts, engine detail. */
export function attentionLine(item: AttentionItem): string {
  const subject = item.subject
    ? `${item.subject.kind} "${item.subject.name ?? item.subject.id}"`
    : item.kind;
  const counts = [
    item.counts.failures ? plural(item.counts.failures, "failure", "failures") : null,
    item.counts.patches ? plural(item.counts.patches, "fix", "fixes") : null,
    item.counts.skills ? plural(item.counts.skills, "skill proposal", "skill proposals") : null,
  ].filter((part): part is string => part !== null);
  const tail = counts.length > 0 ? ` (${counts.join(", ")})` : "";
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `- [${item.class}] ${subject}: ${item.reason.replace(/_/g, " ")}${tail}${detail}`;
}

const ORIGIN_TAG: Record<FailureOrigin, string> = {
  authoring: "[authoring]",
  manual: "[manual]",
  scheduled: "[scheduled]",
  mixed: "[mixed]",
};

const RISK_TAG: Record<RiskSignal["severity"], string> = {
  warn: "[warn]",
  critical: "[critical]",
};

function renderDigest(
  headline: string,
  windowHours: number,
  attention: AttentionV1,
  groups: DigestFailureGroup[],
  risk: RiskSignal[],
): string {
  if (attention.items.length === 0 && groups.length === 0 && risk.length === 0) return headline;
  const lines: string[] = [headline];
  if (attention.items.length > 0) {
    lines.push("");
    for (const item of attention.items) lines.push(attentionLine(item));
  }
  if (risk.length > 0) {
    lines.push("", "Risk signals (leading indicators):");
    for (const r of risk) {
      lines.push(`${RISK_TAG[r.severity]} ${r.headline}`);
      lines.push(`   ${r.detail}`);
    }
  }
  if (groups.length > 0) {
    lines.push("", `Failed runs in the last ${windowHours}h, by cause:`);
    for (const g of groups) {
      const label = g.workflow_name ?? g.workflow_id ?? "(draft)";
      const times = g.count === 1 ? "once" : `${g.count}×`;
      lines.push(`${ORIGIN_TAG[g.origin]} ${label} — failed ${times} (last ${g.last_seen})`);
      lines.push(`   ${g.cause}`);
      // The group stays in the list — what broke is worth reading — but it must
      // not read as a running incident. The line says when it recovered, so the
      // operator does not go looking for a fault that is already fixed.
      if (g.resolved_at) lines.push(`   last ran clean on its schedule ${g.resolved_at}`);
    }
  }
  lines.push("", "Ask me to walk through any of these.");
  return lines.join("\n");
}

/** How many attention lines the compact MCP summary carries before collapsing
 *  the tail to a "+N more" count. Keeps the `instructions` string short enough
 *  to ride every initialize without bloating the handshake. */
export const MCP_SUMMARY_TOP_N = 10;

/**
 * Compact attention summary for the MCP surface — the `instructions` string
 * handed to the client at connect. Rendered from `buildAttention` for the
 * connecting principal: the headline counts the same items `GET /v1/attention`
 * returns, and each line is one of them. Read-only.
 */
export async function buildOperatorHealthSummary(
  db: Db,
  principal: ResolvedPrincipal,
): Promise<{ attention: AttentionV1; text: string }> {
  const attention = await buildAttention(db, principal);
  const parts: string[] = [attentionHeadline(attention)];
  const shown = attention.items.slice(0, MCP_SUMMARY_TOP_N);
  for (const item of shown) parts.push(attentionLine(item));
  const more = attention.items.length - shown.length;
  if (more > 0) parts.push(`- (+${more} more — call get_attention for the full list)`);
  return { attention, text: parts.join("\n") };
}
