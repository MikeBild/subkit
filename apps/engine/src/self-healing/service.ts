// Self-healing orchestration.
//
// Two entry points:
//
//   * `runSelfHealingLoop` — reactive wrapper used by the pg-boss
//     `workflow.repair` queue handler. Loads a failing step snapshot,
//     runs the drift detector, and (if a signal is recognised) hands
//     off to `processDriftSignal` with `allowAutoApply: true`.
//
//   * `processDriftSignal` — the signal-to-candidate pipeline,
//     reusable by reactive AND proactive callers (scheduler tick,
//     admin POST /v1/self-healing/scans, the MCP `self_healing.scan`
//     tool). The unattended scheduler tick passes `allowAutoApply: true`
//     so a `safe` rename/widening drift heals itself instead of parking
//     forever; the operator-invoked admin/MCP scans pass
//     `allowAutoApply: false` so an explicit scan parks for review. All
//     proactive sources share the endpoint dedup guard at the top of
//     this function — an already-active candidate for the same endpoint
//     is refreshed or skipped, never duplicated, so scans no longer pile
//     up identical proposals on every cadence tick.
//
// The downstream sequence inside `processDriftSignal`:
//
//   1. Render the drift diff for the LLM.
//   2. Load the most recent `execution_fixtures` row for the
//      connector/endpoint (if any).
//   3. Bounded repair loop — up to MAX_REPAIR_ATTEMPTS turns of
//      LLM repair -> classifier -> fixture dry-run; rejections fold
//      back into `previous_attempts` so the model revises rather
//      than re-emits.
//   4. Resolve the tenant/workflow policy.
//   5. Decide auto-apply (gated by `options.allowAutoApply`).
//   6. Persist `patch_candidates` row (status='proposed') + audit
//      `PATCH_CANDIDATE_PROPOSED` + outbox event `patch.proposed`.
//   7. Optionally auto-apply (writes a new `workflow_versions` row
//      and an `auto_applied` audit row) when allowed AND all gates
//      pass.
//
// Every decision fires a log line so operators can replay the path
// from pg-boss telemetry alone. Audit rows are written for the four
// enumerated lifecycle events in docs/19.

import { and, desc, eq, inArray } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executionFixtures, patchCandidates } from "../db/schema/index.ts";
import { MAX_REPAIR_ATTEMPTS } from "../execution/timeouts.ts";
import { LlmQuotaExhausted } from "../llm/errors.ts";
import {
  type PatchProposal,
  type PreviousRepairAttempt,
  runRepairFlow,
} from "../llm/flows/repair.ts";
import { log, logger } from "../logging/logger.ts";
import {
  recordLoopDriftToPatchCandidate,
  recordPatchCandidate,
  recordSelfHealingRepairRetried,
} from "../observability/instrumentation.ts";
import { getLatestShape } from "../schema-versions/service.ts";
import { autoApplyPatch } from "./auto-apply.ts";
import { classifyPatch } from "./classifier.ts";
import { analyzeStepFailure, type FailingStepSnapshot, renderDriftDiff } from "./drift-detector.ts";
import { runFixtureDryRun } from "./fixture-runner.ts";
import { resolvePolicy, shouldAutoApply } from "./policy.ts";
import { buildDryRunStep, loadStepSnapshot } from "./step-snapshot.ts";
import {
  candidateDriftFingerprint,
  candidateProposal,
  findMatchingTerminalEndpointCandidate,
  signalFingerprint,
} from "./terminal-dedup.ts";
import type { DriftSignal, DryRunStep, WorkflowRepairJob } from "./types.ts";

export interface SelfHealingResult {
  drift_detected: boolean;
  drift_signal: DriftSignal | null;
  patch_candidate_id: string | null;
  proposal: PatchProposal | null;
  classification: "safe" | "unsafe" | null;
  dry_run_passed: boolean | null;
  auto_applied: boolean;
  reason: string;
}

export interface RunSelfHealingParams extends WorkflowRepairJob {
  /**
   * Tests supply a synthetic step snapshot so they don't have to
   * write a full `execution_steps` row. Production callers leave
   * this undefined — the service pulls the row by id.
   */
  step_snapshot?: FailingStepSnapshot;
}

/**
 * Which subsystem produced the signal. Recorded on the persisted
 * Patch Candidate (inside the `diff` JSONB) so audit consumers can
 * filter "patches born from reactive failures" vs "patches born from
 * a proactive scan" without joining back through pg-boss logs.
 */
export type SignalSource = "reactive" | "proactive_scheduler" | "proactive_admin" | "proactive_mcp";

/**
 * The full context required to turn a `DriftSignal` into a Patch
 * Candidate. Reactive callers populate every field from a failing-step
 * snapshot. Proactive callers (which have no real failing step)
 * synthesise `repair_input.failing_step_id` from the signal's anchor
 * resource and leave `dry_run_step` undefined so the fixture dry-run
 * gate is skipped — there is no concrete persisted step to patch.
 */
export interface SignalContext {
  tenant_id: string;
  workflow_id: string;
  execution_id: string | null;
  step_id: string | null;
  connector_id?: string | null;
  endpoint_key?: string | null;
  actor_id: string | null;
  source: SignalSource;
  /** Set on proactive call paths so candidate rows can be traced
   *  back to the originating `self_healing_scans` row. */
  scan_id?: string;
  /** Input to the LLM repair flow. The `failing_step_id` slot must
   *  carry a stable identifier — the persisted step id for reactive
   *  callers, a `proactive:<kind>:<resource>` token for proactive
   *  callers. The id is only used for prompt grounding + telemetry
   *  metadata; the patch_candidates row is keyed on workflow_id. */
  repair_input: {
    failing_step_id: string;
    request?: unknown;
    response?: unknown;
  };
  /** When present AND a fixture exists for the connector/endpoint,
   *  the dry-run gate runs. Reactive callers always pass this from
   *  the snapshot. Proactive callers leave it undefined: there is no
   *  persisted step config to apply the patch to in-memory, so the
   *  gate is skipped. */
  dry_run_step?: DryRunStep;
}

export interface ProcessSignalOptions {
  /**
   * When false, the function NEVER auto-applies the patch — the
   * candidate is always persisted in `status='proposed'` regardless
   * of classification, fixture dry-run, or policy. The operator-invoked
   * admin HTTP + MCP scans pass false (an explicit scan parks for
   * review). The reactive queue handler and the unattended scheduler
   * tick pass true; the policy/classification/fixture gates then decide
   * whether `autoApplyPatch` runs.
   */
  allowAutoApply: boolean;
}

export interface ProcessSignalResult {
  candidate_id: string;
  classification: "safe" | "unsafe";
  status: "proposed" | "applied" | "rejected" | "superseded";
  auto_applied: boolean;
  dry_run_passed: boolean | null;
  proposal: PatchProposal;
  /**
   * Resolved tenant/workflow autoheal policy at the time the
   * candidate was persisted. Surfaced on the return so callers
   * (e.g. the reactive wrapper, queue handler log line) can include
   * it in observability output without re-resolving.
   */
  policy: import("./policy.ts").AutohealPolicy;
}

async function loadFixture(
  tenant_id: string,
  connector_id: string | null | undefined,
  endpoint_key: string | null | undefined,
  exec: Executor,
): Promise<{ id: string; request: unknown; response: unknown } | null> {
  if (!connector_id || !endpoint_key) return null;
  const rows = await exec
    .select()
    .from(executionFixtures)
    .where(
      and(
        eq(executionFixtures.tenant_id, tenant_id),
        eq(executionFixtures.connector_id, connector_id),
        eq(executionFixtures.endpoint_key, endpoint_key),
        eq(executionFixtures.kind, "fixture"),
      ),
    )
    .orderBy(desc(executionFixtures.captured_at))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, request: row.request, response: row.response };
}

/**
 * Handle a proactive signal whose endpoint already has an active patch
 * candidate. Returns a `ProcessSignalResult` that the caller short-
 * circuits on, or `null` to fall through to the full repair pipeline
 * (only when the existing row is unusable — no stored proposal).
 *
 *   - `applied`  → the fix is already in place; skip silently (no LLM,
 *                  no version churn). Re-applying every hour would
 *                  rotate the workflow version endlessly.
 *   - `proposed` → refresh `updated_at` so the candidate reflects the
 *                  still-live drift, then re-evaluate auto-apply against
 *                  the current policy. A `safe` candidate that was
 *                  parked under the old never-auto-without-fixture rule
 *                  now auto-applies here.
 */
async function refreshOrSkipExistingCandidate(
  db: Db,
  existing: typeof patchCandidates.$inferSelect,
  ctx: SignalContext,
  options: ProcessSignalOptions,
): Promise<ProcessSignalResult | null> {
  const diff = (existing.diff ?? {}) as Record<string, unknown>;
  const proposal = diff.proposal as PatchProposal | undefined;
  if (!proposal) return null;

  // `existing` is already guaranteed (by findActiveEndpointCandidate) to be
  // the candidate that heals THIS drift's fingerprint — a genuinely new drift
  // shape on the same endpoint never reaches here, so this dedup can
  // never mask new breakage.
  const policy = await resolvePolicy(ctx.tenant_id, ctx.workflow_id, db);

  if (existing.status === "applied") {
    // an already-healed endpoint re-diffs the same two schema_versions
    // rows on EVERY proactive scan (the applied patch heals the workflow but
    // does not rewrite the observed schema), so this short-circuit fires
    // hourly per healed endpoint while the drift is UNCHANGED (the fingerprint
    // guard above already let genuinely new drift through). That is the dedup
    // working as designed — an expected, idempotent, non-actionable outcome —
    // so it logs at DEBUG, not INFO: at INFO it flooded the operator log
    // (24×/day) and buried signals that actually need attention.
    logger.debug({
      module: "self-healing",
      action: "patch.already_applied",
      msg: "endpoint already healed by an applied patch — skipping re-proposal",
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      patch_candidate_id: existing.id,
      connector_id: ctx.connector_id ?? null,
      endpoint_key: ctx.endpoint_key ?? null,
      source: ctx.source,
    });
    return {
      candidate_id: existing.id,
      classification: existing.classification,
      status: "applied",
      auto_applied: false,
      dry_run_passed: null,
      proposal,
      policy,
    };
  }

  // status === 'proposed' — proactive scans never have a fixture, so
  // the auto-apply decision rests solely on classification + policy.
  const wouldAutoApply = shouldAutoApply({
    policy,
    classification: existing.classification,
    fixture_passed: false,
    has_fixture: false,
  });
  const autoApply = options.allowAutoApply && wouldAutoApply;

  const appliedVersionId = await db.transaction(async (tx) => {
    await tx
      .update(patchCandidates)
      .set({ updated_at: new Date() })
      .where(eq(patchCandidates.id, existing.id));
    if (!autoApply) return null;
    const versionId = await autoApplyPatch(tx, {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      candidate_id: existing.id,
      proposal,
    });
    if (versionId) {
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "system",
          action: AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
          resource_type: "patch_candidate",
          resource_id: existing.id,
          result: "success",
          metadata: {
            workflow_id: ctx.workflow_id,
            new_workflow_version_id: versionId,
            classification: existing.classification,
            policy,
            source: ctx.source,
            via: "proactive_refresh",
          },
        },
        tx,
      );
    }
    return versionId;
  });

  const auto_applied = !!appliedVersionId;
  recordPatchCandidate({
    classification: existing.classification,
    decision: auto_applied ? "auto_applied" : "parked",
  });
  logger.info({
    module: "self-healing",
    action: auto_applied ? "patch.auto_applied" : "patch.refreshed",
    msg: auto_applied
      ? "self-healing auto-applied a refreshed proactive patch"
      : "refreshed existing proactive patch candidate — no duplicate row",
    tenant_id: ctx.tenant_id,
    workflow_id: ctx.workflow_id,
    patch_candidate_id: existing.id,
    classification: existing.classification,
    policy,
    source: ctx.source,
  });

  return {
    candidate_id: existing.id,
    classification: existing.classification,
    status: auto_applied ? "applied" : "proposed",
    auto_applied,
    dry_run_passed: null,
    proposal,
    policy,
  };
}

/**
 * Find an already-active patch candidate (status proposed|applied) for
 * the same endpoint anchor, newest first. The proactive scan uses this
 * to refresh-or-skip instead of inserting a fresh row every cadence
 * tick — the patch_candidates flood fix. Returns null when the signal
 * has no endpoint anchor (workflow-scoped drift) or none is active.
 */
async function findActiveEndpointCandidate(
  exec: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    connector_id: string;
    endpoint_key: string;
    signal: DriftSignal;
  },
) {
  // return the active candidate that heals THIS drift's fingerprint,
  // not merely the most-recent candidate on the endpoint. The pre-fix
  // single-row lookup masked new breakage: when an endpoint had an applied
  // candidate for drift A and a genuinely different drift B appeared, the
  // lookup returned A and the `status==="applied"` short-circuit skipped B —
  // so B was never proposed or healed. Matching by fingerprint (the same
  // canonical form findMatchingTerminalEndpointCandidate uses) lets a new
  // drift fall through to a fresh proposal while the same drift still dedups.
  const rows = await exec
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, params.tenant_id),
        eq(patchCandidates.workflow_id, params.workflow_id),
        eq(patchCandidates.connector_id, params.connector_id),
        eq(patchCandidates.endpoint_key, params.endpoint_key),
        inArray(patchCandidates.status, ["proposed", "applied"]),
      ),
    )
    .orderBy(desc(patchCandidates.created_at))
    .limit(10);
  const fingerprint = signalFingerprint(params.signal);
  const match = rows.find((r) => candidateDriftFingerprint(r) === fingerprint);
  if (match) return match;
  // No fingerprint match. A legacy candidate (created before drift_signal was
  // stored) carries no fingerprint to compare — dedup against it to preserve
  // the old endpoint-only behaviour and avoid re-proposal flood for those
  // rows. If every active candidate is fingerprinted and none match, this is
  // a NEW drift → return null so it gets a fresh proposal.
  return rows.find((r) => candidateDriftFingerprint(r) === null) ?? null;
}

/**
 * Turn a recognised drift signal into a persisted Patch Candidate.
 *
 * Reactive callers (the pg-boss `workflow.repair` handler) pass
 * `allowAutoApply: true` and the existing classification + fixture +
 * policy gates decide whether the patch auto-applies.
 *
 * Proactive callers (scheduler tick, admin POST, MCP) pass
 * `allowAutoApply: true` as well now — the relaxed policy auto-applies
 * `safe` rename/widening patches even without a fixture, so a clean
 * proactive drift heals itself instead of parking forever. Before any
 * LLM work, a proactive signal that already has an active candidate for
 * the same endpoint is short-circuited: an `applied` candidate means
 * the fix is already in place (skip), a `proposed` one is refreshed in
 * place and re-evaluated for auto-apply (no duplicate row, no repeat
 * LLM spend). This is what stops the hourly patch_candidates flood.
 */
export async function processDriftSignal(
  signal: DriftSignal,
  ctx: SignalContext,
  options: ProcessSignalOptions,
  exec?: Db,
): Promise<ProcessSignalResult> {
  const db = exec ?? getDb();

  // Proactive idempotency guard. Reactive failures are genuine new
  // events and keep the original behaviour; proactive scans re-fire on
  // a cadence against unchanged recorded state, so they must dedupe.
  const isProactive = ctx.source !== "reactive";
  if (isProactive && ctx.connector_id && ctx.endpoint_key) {
    const existing = await findActiveEndpointCandidate(db, {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
      signal,
    });
    if (existing) {
      const dedup = await refreshOrSkipExistingCandidate(db, existing, ctx, options);
      if (dedup) return dedup;
    }
    const terminal = await findMatchingTerminalEndpointCandidate(db, {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
      signal,
    });
    if (terminal) {
      const policy = await resolvePolicy(ctx.tenant_id, ctx.workflow_id, db);
      logger.info({
        module: "self-healing",
        action: "patch.terminal_dedup",
        msg: "skipping proactive drift repair because a terminal candidate already covers the same drift fingerprint",
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        patch_candidate_id: terminal.id,
        terminal_status: terminal.status,
        classification: terminal.classification,
        source: ctx.source,
      });
      return {
        candidate_id: terminal.id,
        classification: terminal.classification,
        status: terminal.status,
        auto_applied: false,
        dry_run_passed: null,
        proposal: candidateProposal(terminal),
        policy,
      };
    }
  }

  const diff = renderDriftDiff(signal);
  const fixture = await loadFixture(
    ctx.tenant_id,
    ctx.connector_id ?? null,
    ctx.endpoint_key ?? null,
    db,
  );

  // Bounded repair loop. The LLM may need to revise — fold each
  // rejection back into prior_failures so the next attempt is not a
  // near-duplicate.
  const rejectionChain: Array<{
    attempt: number;
    classification: "safe" | "unsafe";
    dry_run_passed: boolean | null;
    reason: string;
  }> = [];
  const previousAttempts: PreviousRepairAttempt[] = [];

  let proposal: PatchProposal | null = null;
  let decision: ReturnType<typeof classifyPatch> | null = null;
  let dryRunOk = false;
  let dryRunError: string | undefined;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    let repair: Awaited<ReturnType<typeof runRepairFlow>>;
    try {
      repair = await runRepairFlow(
        {
          tenant_id: ctx.tenant_id,
          execution_id: ctx.execution_id ?? ctx.scan_id ?? "proactive",
          failing_step: {
            id: ctx.repair_input.failing_step_id,
            ...(ctx.repair_input.request !== undefined
              ? { request: ctx.repair_input.request }
              : {}),
            ...(ctx.repair_input.response !== undefined
              ? { response: ctx.repair_input.response }
              : {}),
          },
          drift_diff: diff,
          ...(ctx.connector_id ? { connector_id: ctx.connector_id } : {}),
          ...(previousAttempts.length > 0 ? { previous_attempts: [...previousAttempts] } : {}),
        },
        db,
      );
    } catch (err) {
      if (err instanceof LlmQuotaExhausted && proposal) {
        logger.warn({
          module: "self-healing",
          action: "repair.budget_exhausted",
          msg: "LLM budget exhausted mid-retry — persisting last proposal",
          tenant_id: ctx.tenant_id,
          workflow_id: ctx.workflow_id,
          attempts_done: attempt - 1,
        });
        break;
      }
      throw err;
    }

    proposal = repair.patch_proposal;
    decision = classifyPatch(proposal, signal);
    logger.info({
      module: "self-healing",
      action: "patch.classified",
      msg: "patch classified",
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      classification: decision.classification,
      reasons: decision.reasons,
      attempt,
      source: ctx.source,
    });

    // Fixture dry-run gate. Skipped entirely when the caller has no
    // concrete DryRunStep (proactive scans) or when no fixture row
    // exists for the connector/endpoint.
    dryRunOk = false;
    dryRunError = undefined;
    if (fixture && ctx.dry_run_step) {
      const dryRun = await runFixtureDryRun({
        step: ctx.dry_run_step,
        patch: proposal,
        fixture: { request: fixture.request, response: fixture.response },
      });
      dryRunOk = dryRun.ok;
      if (!dryRun.ok) dryRunError = dryRun.error;
      if (dryRun.ok) {
        log.selfHealing.fixture.passed({
          tenant_id: ctx.tenant_id,
          workflow_id: ctx.workflow_id,
          fixture_id: fixture.id,
        });
      } else {
        log.selfHealing.fixture.failed({
          tenant_id: ctx.tenant_id,
          workflow_id: ctx.workflow_id,
          fixture_id: fixture.id,
          error: dryRun.error,
        });
      }
    } else if (attempt === 1) {
      logger.info({
        module: "self-healing",
        action: "fixture.missing",
        msg: ctx.dry_run_step
          ? "no fixture available — auto-apply disabled"
          : "no dry-run step (proactive scan) — fixture gate skipped",
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        source: ctx.source,
      });
    }

    const classifierOk = decision.classification === "safe";
    const fixtureOk = !fixture || !ctx.dry_run_step || dryRunOk;
    if (classifierOk && fixtureOk) break;

    const reason =
      !classifierOk && !fixtureOk
        ? `unsafe classification (${decision.reasons.join("; ") || "no reasons"}) and fixture dry-run failed (${dryRunError ?? "unknown"})`
        : !classifierOk
          ? `unsafe classification: ${decision.reasons.join("; ") || "no reasons"}`
          : `fixture dry-run failed: ${dryRunError ?? "unknown"}`;
    rejectionChain.push({
      attempt,
      classification: decision.classification,
      dry_run_passed: fixture && ctx.dry_run_step ? dryRunOk : null,
      reason,
    });
    previousAttempts.push({ proposal, rejection: reason });
  }

  if (!proposal || !decision) {
    throw new Error("repair flow returned no proposal");
  }

  if (rejectionChain.length > 0) {
    recordSelfHealingRepairRetried({
      tenant_id: ctx.tenant_id,
      attempts: rejectionChain.length + 1,
    });
  }

  const policy = await resolvePolicy(ctx.tenant_id, ctx.workflow_id, db);
  const wouldAutoApply = shouldAutoApply({
    policy,
    classification: decision.classification,
    fixture_passed: dryRunOk,
    has_fixture: !!fixture && !!ctx.dry_run_step,
  });
  const autoApply = options.allowAutoApply && wouldAutoApply;

  logger.info({
    module: "self-healing",
    action: "policy.resolved",
    msg: "auto-heal policy resolved",
    tenant_id: ctx.tenant_id,
    workflow_id: ctx.workflow_id,
    policy,
    classification: decision.classification,
    has_fixture: Boolean(fixture && ctx.dry_run_step),
    fixture_passed: dryRunOk,
    auto_apply: autoApply,
    auto_apply_allowed_by_caller: options.allowAutoApply,
    source: ctx.source,
  });

  const txOut = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .insert(patchCandidates)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        // Endpoint anchor for the refresh-or-skip dedup on the next
        // proactive scan. Null for workflow-scoped signals.
        connector_id: ctx.connector_id ?? null,
        endpoint_key: ctx.endpoint_key ?? null,
        classification: decision.classification,
        // Only stamp `fixture_id` on the row when the dry-run gate
        // actually ran against this fixture. Proactive scans load
        // the fixture (so connector+endpoint match a recorded one)
        // but skip the gate because they have no concrete persisted
        // step to apply the patch to in-memory — stamping the id
        // would mislead operators into thinking the patch was
        // dry-run-validated.
        ...(fixture && ctx.dry_run_step ? { fixture_id: fixture.id } : {}),
        diff: {
          drift_signal: signal,
          drift_diff: diff,
          proposal,
          classification_reasons: decision.reasons,
          dry_run: {
            ok: dryRunOk,
            error: dryRunError ?? null,
            fixture_id: fixture?.id ?? null,
            // Records that we never even ran the gate — useful when
            // operators read the candidate diff and wonder why
            // dry_run.ok is false.
            skipped: !ctx.dry_run_step || !fixture,
          },
          policy,
          step_id: ctx.step_id,
          execution_id: ctx.execution_id,
          source: ctx.source,
          ...(ctx.scan_id ? { scan_id: ctx.scan_id } : {}),
          ...(rejectionChain.length > 0 ? { rejection_chain: rejectionChain } : {}),
        },
        status: "proposed",
      })
      .returning();
    assertInsertRow(candidate, "patch_candidates");

    // Only stamp `fixture_id` on the audit metadata when the dry-run
    // gate actually ran against it. Mirrors the same predicate used
    // for the patch_candidates.fixture_id column above so forensic
    // queries on the audit row never imply a candidate was fixture-
    // validated when the gate was skipped (proactive scans).
    const gatedFixtureId = fixture && ctx.dry_run_step ? fixture.id : null;
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        actor_type: "system",
        action: AuditAction.PATCH_CANDIDATE_PROPOSED,
        resource_type: "patch_candidate",
        resource_id: candidate.id,
        result: "success",
        metadata: {
          workflow_id: ctx.workflow_id,
          classification: decision.classification,
          policy,
          drift_kind: signal.kind,
          fixture_id: gatedFixtureId,
          dry_run_ok: dryRunOk,
          dry_run_skipped: !ctx.dry_run_step || !fixture,
          reasons: decision.reasons,
          source: ctx.source,
          ...(ctx.scan_id ? { scan_id: ctx.scan_id } : {}),
        },
      },
      tx,
    );

    log.selfHealing.patch.proposed({
      candidate_id: candidate.id,
      workflow_id: ctx.workflow_id,
      tenant_id: ctx.tenant_id,
      classification: decision.classification,
      policy,
      dry_run_ok: dryRunOk,
      auto_apply: autoApply,
    });
    await writeEvent(tx, {
      tenant_id: ctx.tenant_id,
      channel: "notification.emitted",
      type: "patch.proposed",
      payload: {
        patch_candidate_id: candidate.id,
        workflow_id: ctx.workflow_id,
        classification: decision.classification,
        policy,
        dry_run_ok: dryRunOk,
        source: ctx.source,
        ...(ctx.scan_id ? { scan_id: ctx.scan_id } : {}),
      },
    });

    let appliedVersionId: string | null = null;
    if (autoApply) {
      appliedVersionId = await autoApplyPatch(tx, {
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        candidate_id: candidate.id,
        proposal,
      });
      if (appliedVersionId) {
        await auditAwait(
          {
            tenant_id: ctx.tenant_id,
            actor_type: "system",
            action: AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
            resource_type: "patch_candidate",
            resource_id: candidate.id,
            result: "success",
            metadata: {
              workflow_id: ctx.workflow_id,
              new_workflow_version_id: appliedVersionId,
              fixture_id: gatedFixtureId,
              classification: decision.classification,
              policy,
              source: ctx.source,
            },
          },
          tx,
        );
      }
    }

    return { candidate, appliedVersionId };
  });

  const auto_applied = !!txOut.appliedVersionId;
  recordPatchCandidate({
    classification: decision.classification,
    decision: auto_applied ? "auto_applied" : "parked",
  });
  // Opening edge of the Run → Drift → Patch → Skill loop (docs/execution.md):
  // a drift signal just became a Patch Candidate. Tenant-scoped sibling of the
  // tenant-less patch_candidates_total above.
  recordLoopDriftToPatchCandidate({
    tenant_id: ctx.tenant_id,
    classifier: decision.classification,
  });
  logger.info({
    module: "self-healing",
    action: auto_applied ? "patch.auto_applied" : "patch.parked",
    msg: auto_applied ? "self-healing auto-applied patch" : "self-healing parked patch for review",
    tenant_id: ctx.tenant_id,
    workflow_id: ctx.workflow_id,
    patch_candidate_id: txOut.candidate.id,
    classification: decision.classification,
    policy,
    fixture_passed: dryRunOk,
    source: ctx.source,
  });

  return {
    candidate_id: txOut.candidate.id,
    classification: decision.classification,
    status: auto_applied ? "applied" : "proposed",
    auto_applied,
    dry_run_passed: fixture && ctx.dry_run_step ? dryRunOk : null,
    proposal,
    policy,
  };
}

export async function runSelfHealingLoop(
  params: RunSelfHealingParams,
  exec?: Db,
): Promise<SelfHealingResult> {
  const db = exec ?? getDb();

  // 1. Pull the failing step snapshot (or use the one the caller
  // handed us directly — tests do this to avoid seeding noise).
  let snapshot: FailingStepSnapshot | null = params.step_snapshot ?? null;
  if (!snapshot && params.step_id) {
    snapshot = await loadStepSnapshot(params.tenant_id, params.step_id, db);
  }
  if (!snapshot) {
    logger.warn({
      module: "self-healing",
      action: "loop.no_snapshot",
      msg: "self-healing loop skipped — no step snapshot",
      tenant_id: params.tenant_id,
      workflow_id: params.workflow_id,
      step_id: params.step_id,
    });
    return emptyResult("no step snapshot available");
  }

  // 2. Pull the last known shape for the connector/endpoint, if any.
  let lastShape = null;
  if (params.connector_id && params.endpoint_key) {
    lastShape = await getLatestShape(
      {
        tenant_id: params.tenant_id,
        connector_id: params.connector_id,
        endpoint_key: params.endpoint_key,
      },
      db,
    );
  }

  // 3. Drift detection.
  const signal = analyzeStepFailure(snapshot, lastShape);
  if (!signal) {
    logger.info({
      module: "self-healing",
      action: "drift.none",
      msg: "no drift signal — self-healing loop exits",
      tenant_id: params.tenant_id,
      workflow_id: params.workflow_id,
      step_id: params.step_id,
    });
    return emptyResult("no drift signal");
  }

  log.selfHealing.drift.detected({
    msg: "drift signal detected",
    tenant_id: params.tenant_id,
    workflow_id: params.workflow_id,
    step_id: params.step_id,
    drift_kind: signal.kind,
  });

  let result: ProcessSignalResult;
  try {
    result = await processDriftSignal(
      signal,
      {
        tenant_id: params.tenant_id,
        workflow_id: params.workflow_id,
        execution_id: params.execution_id,
        step_id: snapshot.id,
        connector_id: params.connector_id ?? null,
        endpoint_key: params.endpoint_key ?? null,
        actor_id: null,
        source: "reactive",
        repair_input: {
          failing_step_id: snapshot.id,
          request: snapshot.request_meta,
          response: snapshot.output_preview,
        },
        dry_run_step: buildDryRunStep(snapshot),
      },
      { allowAutoApply: true },
      db,
    );
  } catch (err) {
    if (err instanceof Error && err.message === "repair flow returned no proposal") {
      return emptyResult("repair flow returned no proposal");
    }
    throw err;
  }

  return {
    drift_detected: true,
    drift_signal: signal,
    patch_candidate_id: result.candidate_id,
    proposal: result.proposal,
    classification: result.classification,
    dry_run_passed: result.dry_run_passed,
    auto_applied: result.auto_applied,
    reason: result.auto_applied
      ? `auto-applied (policy=${result.policy})`
      : `parked (policy=${result.policy}, classification=${result.classification})`,
  };
}

function emptyResult(reason: string): SelfHealingResult {
  return {
    drift_detected: false,
    drift_signal: null,
    patch_candidate_id: null,
    proposal: null,
    classification: null,
    dry_run_passed: null,
    auto_applied: false,
    reason,
  };
}
