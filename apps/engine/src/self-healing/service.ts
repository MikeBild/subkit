// Self-healing orchestration.
//
// `runSelfHealingLoop` is the single entry point the queue handler
// calls. It ties together every module in this folder:
//
//   1. Load the failing `execution_steps` row (or a synthetic snapshot
//      passed directly by callers that already hold it).
//   2. Pull the last `schema_versions` row for the connector/endpoint.
//   3. Run the drift detector.
//   4. If drift is recognised, call the `repair` LLM flow with the
//      rendered drift diff.
//   5. Persist a `patch_candidates` row with `status = 'proposed'`.
//   6. Classify the proposal.
//   7. Load the most recent `execution_fixtures` row for the endpoint
//      and run the fixture dry-run.
//   8. Resolve the tenant/workflow policy and decide auto-apply.
//   9. Auto-apply (write a new `workflow_versions` row + audit row)
//      OR park for review (`status = 'proposed'` stays).
//  10. Write the `patch.proposed` outbox event regardless.
//
// Every decision fires a log line so operators can replay the path
// from pg-boss telemetry alone. Audit rows are written for the four
// enumerated lifecycle events in docs/19.

import { and, desc, eq } from "drizzle-orm";
import { audit, auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, getDb } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import {
  executionFixtures,
  executionSteps,
  patchCandidates,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { RequestMetaSchema } from "../execution/request-meta-schema.ts";
import { MAX_REPAIR_ATTEMPTS } from "../execution/timeouts.ts";
import { LlmQuotaExhausted } from "../llm/errors.ts";
import {
  type PatchProposal,
  type PreviousRepairAttempt,
  runRepairFlow,
} from "../llm/flows/repair.ts";
import { log, logger } from "../logging/logger.ts";
import {
  recordPatchCandidate,
  recordSelfHealingRepairRetried,
} from "../observability/instrumentation.ts";
import { getLatestShape } from "../schema-versions/service.ts";
import { classifyPatch } from "./classifier.ts";
import { analyzeStepFailure, type FailingStepSnapshot, renderDriftDiff } from "./drift-detector.ts";
import { runFixtureDryRun } from "./fixture-runner.ts";
import { resolvePolicy, shouldAutoApply } from "./policy.ts";
import type { DriftSignal, DryRunStep, WorkflowRepairJob } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

function buildDryRunStep(snapshot: FailingStepSnapshot): DryRunStep {
  // `data_selector` / `response_filters` / `expression` come from the
  // persisted step config (whoever upstream loaded the snapshot
  // populated `snapshot.expression`); the typed RequestMeta union
  // intentionally doesn't carry them. Future expansion: surface
  // additional dry-run inputs on FailingStepSnapshot itself.
  const kind = snapshot.kind === "transform" ? "transform" : "request";
  const step: DryRunStep = { id: snapshot.id, kind };
  if (typeof snapshot.expression === "string") step.expression = snapshot.expression;
  return step;
}

/**
 * Parse the persisted JSONB request_meta payload through the strict
 * RequestMeta schema. Tolerant fall-through: rows persisted before
 * the typed-union migration, or with a future driver variant we
 * don't recognise here, return `null` rather than crashing the
 * repair loop.
 */
function parsePersistedRequestMeta(
  raw: unknown,
): import("../execution/types.ts").RequestMeta | null {
  if (raw === null || raw === undefined) return null;
  const parsed = RequestMetaSchema.safeParse(raw);
  return parsed.success ? (parsed.data as import("../execution/types.ts").RequestMeta) : null;
}

async function loadStepSnapshot(
  step_id: string,
  exec: Executor,
): Promise<FailingStepSnapshot | null> {
  // tenant-filter:exempt — drift detection sweeps every tenant
  const rows = await exec
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.id, step_id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    error: row.error,
    request_meta: parsePersistedRequestMeta(row.request_meta),
    output_preview: row.output_preview,
  };
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
 * Auto-apply a safe patch by writing a new workflow version whose `dag`
 * carries an appended `__self_healing` annotation. The engine does NOT
 * try to surgically rewrite the upstream DAG — the repair flow's
 * narrow palette is applied out-of-band on the NEXT execution by the
 * request driver, which reads the patch_candidates row and layers the
 * rename on top of the live step. The workflow_versions insert is the
 * audit anchor that makes the change reviewable and reversible.
 */
async function autoApplyPatch(
  tx: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    candidate_id: string;
    proposal: PatchProposal;
  },
): Promise<string | null> {
  // tenant-filter:exempt — drift detection sweeps every tenant
  const wfRows = await tx
    .select()
    .from(workflows)
    .where(eq(workflows.id, params.workflow_id))
    .limit(1);
  const wf = wfRows[0];
  if (!wf?.current_version_id) return null;

  // tenant-filter:exempt — drift detection sweeps every tenant
  const cvRows = await tx
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, wf.current_version_id))
    .limit(1);
  const currentVersion = cvRows[0];
  if (!currentVersion) return null;

  const newDag = {
    ...(currentVersion.dag as Record<string, unknown>),
    __self_healing: {
      applied_patch_id: params.candidate_id,
      kind: params.proposal.kind,
      description: params.proposal.description,
      applied_at: new Date().toISOString(),
    },
  };

  // tenant-filter:exempt — drift detection sweeps every tenant
  const maxRows = (await tx
    .select({
      max_version: workflowVersions.version,
    })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflow_id, params.workflow_id))
    .orderBy(desc(workflowVersions.version))
    .limit(1)) as Array<{ max_version: number }>;
  const next = (maxRows[0]?.max_version ?? 0) + 1;

  const [inserted] = await tx
    .insert(workflowVersions)
    .values({
      tenant_id: params.tenant_id,
      workflow_id: params.workflow_id,
      version: next,
      dag: newDag,
      note: `self-healing auto-apply of patch ${params.candidate_id}`,
    })
    .returning();
  if (!inserted) return null;

  await tx
    .update(workflows)
    .set({ current_version_id: inserted.id, updated_at: new Date() })
    .where(eq(workflows.id, params.workflow_id));

  await tx
    .update(patchCandidates)
    .set({ status: "applied", updated_at: new Date() })
    .where(eq(patchCandidates.id, params.candidate_id));

  return inserted.id;
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
    snapshot = await loadStepSnapshot(params.step_id, db);
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

  // 4–6. Bounded repair loop. We let the LLM revise up to
  // MAX_REPAIR_ATTEMPTS times when the classifier marks the proposal
  // unsafe OR the fixture dry-run rejects it. Rejection context is
  // folded into `prior_failures` so each attempt starts with the
  // structured reasons the previous attempt was rejected.
  const diff = renderDriftDiff(signal);
  const fixture = await loadFixture(params.tenant_id, params.connector_id, params.endpoint_key, db);

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
          tenant_id: params.tenant_id,
          execution_id: params.execution_id ?? "unknown",
          failing_step: {
            id: snapshot.id,
            request: snapshot.request_meta,
            response: snapshot.output_preview,
          },
          drift_diff: diff,
          ...(params.connector_id ? { connector_id: params.connector_id } : {}),
          ...(previousAttempts.length > 0 ? { previous_attempts: [...previousAttempts] } : {}),
        },
        db,
      );
    } catch (err) {
      // Budget exhaustion aborts the retry loop but keeps whatever we
      // proposed last so the operator still has something to review.
      if (err instanceof LlmQuotaExhausted && proposal) {
        logger.warn({
          module: "self-healing",
          action: "repair.budget_exhausted",
          msg: "LLM budget exhausted mid-retry — persisting last proposal",
          tenant_id: params.tenant_id,
          workflow_id: params.workflow_id,
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
      tenant_id: params.tenant_id,
      workflow_id: params.workflow_id,
      classification: decision.classification,
      reasons: decision.reasons,
      attempt,
    });

    // Fixture dry-run for this attempt (no network).
    dryRunOk = false;
    dryRunError = undefined;
    if (fixture) {
      const dryRun = await runFixtureDryRun({
        step: buildDryRunStep(snapshot),
        patch: proposal,
        fixture: { request: fixture.request, response: fixture.response },
      });
      dryRunOk = dryRun.ok;
      if (!dryRun.ok) dryRunError = dryRun.error;
      if (dryRun.ok) {
        log.selfHealing.fixture.passed({
          tenant_id: params.tenant_id,
          workflow_id: params.workflow_id,
          fixture_id: fixture.id,
        });
      } else {
        log.selfHealing.fixture.failed({
          tenant_id: params.tenant_id,
          workflow_id: params.workflow_id,
          fixture_id: fixture.id,
          error: dryRun.error,
        });
      }
    } else if (attempt === 1) {
      logger.info({
        module: "self-healing",
        action: "fixture.missing",
        msg: "no fixture available — auto-apply disabled",
        tenant_id: params.tenant_id,
        workflow_id: params.workflow_id,
      });
    }

    // Stop as soon as the proposal clears both gates.
    const classifierOk = decision.classification === "safe";
    const fixtureOk = !fixture || dryRunOk;
    if (classifierOk && fixtureOk) break;

    // Record the rejection reason and feed it into the next attempt.
    const reason =
      !classifierOk && !fixtureOk
        ? `unsafe classification (${decision.reasons.join("; ") || "no reasons"}) and fixture dry-run failed (${dryRunError ?? "unknown"})`
        : !classifierOk
          ? `unsafe classification: ${decision.reasons.join("; ") || "no reasons"}`
          : `fixture dry-run failed: ${dryRunError ?? "unknown"}`;
    rejectionChain.push({
      attempt,
      classification: decision.classification,
      dry_run_passed: fixture ? dryRunOk : null,
      reason,
    });
    previousAttempts.push({ proposal, rejection: reason });
  }

  if (!proposal || !decision) {
    // Defensive: should not reach here because the loop always runs at
    // least once. Fall back to empty-result semantics.
    return emptyResult("repair flow returned no proposal");
  }

  if (rejectionChain.length > 0) {
    recordSelfHealingRepairRetried({
      tenant_id: params.tenant_id,
      attempts: rejectionChain.length + 1,
    });
  }

  // 7. Resolve policy.
  const policy = await resolvePolicy(params.tenant_id, params.workflow_id, db);
  const autoApply = shouldAutoApply({
    policy,
    classification: decision.classification,
    fixture_passed: dryRunOk,
    has_fixture: !!fixture,
  });
  logger.info({
    module: "self-healing",
    action: "policy.resolved",
    msg: "auto-heal policy resolved",
    tenant_id: params.tenant_id,
    workflow_id: params.workflow_id,
    policy,
    classification: decision.classification,
    has_fixture: Boolean(fixture),
    fixture_passed: dryRunOk,
    auto_apply: autoApply,
  });

  // 8. Write the patch_candidates row + audit + optionally auto-apply
  // all inside a single transaction so the outbox event + audit rows
  // commit with the domain change.
  const txOut = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .insert(patchCandidates)
      .values({
        tenant_id: params.tenant_id,
        workflow_id: params.workflow_id,
        classification: decision.classification,
        ...(fixture ? { fixture_id: fixture.id } : {}),
        diff: {
          drift_signal: signal,
          drift_diff: diff,
          proposal,
          classification_reasons: decision.reasons,
          dry_run: { ok: dryRunOk, error: dryRunError ?? null, fixture_id: fixture?.id ?? null },
          policy,
          step_id: snapshot.id,
          execution_id: params.execution_id,
          ...(rejectionChain.length > 0 ? { rejection_chain: rejectionChain } : {}),
        },
        status: "proposed",
      })
      .returning();
    assertInsertRow(candidate, "patch_candidates");

    // patch_candidate.proposed audit row.
    await auditAwait(
      {
        tenant_id: params.tenant_id,
        actor_type: "system",
        action: AuditAction.PATCH_CANDIDATE_PROPOSED,
        resource_type: "patch_candidate",
        resource_id: candidate.id,
        result: "success",
        metadata: {
          workflow_id: params.workflow_id,
          classification: decision.classification,
          policy,
          drift_kind: signal.kind,
          fixture_id: fixture?.id ?? null,
          dry_run_ok: dryRunOk,
          reasons: decision.reasons,
        },
      },
      tx,
    );

    // patch.proposed outbox event.
    log.selfHealing.patch.proposed({
      candidate_id: candidate.id,
      workflow_id: params.workflow_id,
      tenant_id: params.tenant_id,
      classification: decision.classification,
      policy,
      dry_run_ok: dryRunOk,
      auto_apply: autoApply,
    });
    await writeEvent(tx, {
      tenant_id: params.tenant_id,
      channel: "notification.emitted",
      type: "patch.proposed",
      payload: {
        patch_candidate_id: candidate.id,
        workflow_id: params.workflow_id,
        classification: decision.classification,
        policy,
        dry_run_ok: dryRunOk,
      },
    });

    let appliedVersionId: string | null = null;
    if (autoApply) {
      appliedVersionId = await autoApplyPatch(tx, {
        tenant_id: params.tenant_id,
        workflow_id: params.workflow_id,
        candidate_id: candidate.id,
        proposal,
      });
      if (appliedVersionId) {
        await auditAwait(
          {
            tenant_id: params.tenant_id,
            actor_type: "system",
            action: AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
            resource_type: "patch_candidate",
            resource_id: candidate.id,
            result: "success",
            metadata: {
              workflow_id: params.workflow_id,
              new_workflow_version_id: appliedVersionId,
              fixture_id: fixture?.id ?? null,
              classification: decision.classification,
              policy,
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
  logger.info({
    module: "self-healing",
    action: auto_applied ? "patch.auto_applied" : "patch.parked",
    msg: auto_applied ? "self-healing auto-applied patch" : "self-healing parked patch for review",
    tenant_id: params.tenant_id,
    workflow_id: params.workflow_id,
    patch_candidate_id: txOut.candidate.id,
    classification: decision.classification,
    policy,
    fixture_passed: dryRunOk,
  });

  return {
    drift_detected: true,
    drift_signal: signal,
    patch_candidate_id: txOut.candidate.id,
    proposal,
    classification: decision.classification,
    dry_run_passed: fixture ? dryRunOk : null,
    auto_applied,
    reason: auto_applied
      ? `auto-applied (policy=${policy})`
      : `parked (policy=${policy}, classification=${decision.classification})`,
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

/**
 * Convenience helper used by reviewer HTTP routes. Applies a pending
 * candidate manually and writes the `patch_candidate.approved` audit
 * row. Returns the new workflow_versions id, or null if the candidate
 * could not be found.
 */
export async function approvePatchCandidate(
  params: { tenant_id: string; candidate_id: string; actor_id: string | null },
  exec?: Db,
): Promise<string | null> {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, params.tenant_id),
          eq(patchCandidates.id, params.candidate_id),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.status !== "proposed") return null;

    const diff = (row.diff ?? {}) as Record<string, unknown>;
    const proposalRaw = diff.proposal as PatchProposal | undefined;
    if (!proposalRaw) return null;

    const applied = await autoApplyPatch(tx, {
      tenant_id: params.tenant_id,
      workflow_id: row.workflow_id,
      candidate_id: row.id,
      proposal: proposalRaw,
    });
    await auditAwait(
      {
        tenant_id: params.tenant_id,
        actor_type: params.actor_id ? "user" : "system",
        actor_id: params.actor_id,
        action: AuditAction.PATCH_CANDIDATE_APPROVED,
        resource_type: "patch_candidate",
        resource_id: row.id,
        result: "success",
        metadata: { workflow_id: row.workflow_id, new_workflow_version_id: applied },
      },
      tx,
    );
    recordPatchCandidate({ classification: "manual", decision: "approved" });
    log.selfHealing.patch.applied({
      candidate_id: row.id,
      workflow_id: row.workflow_id,
      new_workflow_version_id: applied,
      actor_id: params.actor_id,
      decision: "manual_approve",
    });
    return applied;
  });
}

export async function rejectPatchCandidate(
  params: {
    tenant_id: string;
    candidate_id: string;
    actor_id: string | null;
    reason?: string;
  },
  exec?: Db,
): Promise<boolean> {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(patchCandidates)
      .set({ status: "rejected", updated_at: new Date() })
      .where(
        and(
          eq(patchCandidates.tenant_id, params.tenant_id),
          eq(patchCandidates.id, params.candidate_id),
          eq(patchCandidates.status, "proposed"),
        ),
      )
      .returning();
    if (rows.length === 0) return false;
    audit(
      {
        tenant_id: params.tenant_id,
        actor_type: params.actor_id ? "user" : "system",
        actor_id: params.actor_id,
        action: AuditAction.PATCH_CANDIDATE_REJECTED,
        resource_type: "patch_candidate",
        resource_id: params.candidate_id,
        result: "success",
        ...(params.reason ? { reason: params.reason } : {}),
      },
      tx,
    );
    recordPatchCandidate({ classification: "manual", decision: "rejected" });
    log.selfHealing.patch.rejected({
      candidate_id: params.candidate_id,
      actor_id: params.actor_id,
      reason: params.reason ?? null,
    });
    return true;
  });
}
