import { and, desc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import type { AuditActorType } from "../audit/types.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executionFixtures, executions, type patchCandidates } from "../db/schema/index.ts";
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
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import { autoApplyPatch, logPatchNotApplied } from "./auto-apply.ts";
import { classifyPatch } from "./classifier.ts";
import { analyzeStepFailure, type FailingStepSnapshot, renderDriftDiff } from "./drift-detector.ts";
import { runFixtureDryRun } from "./fixture-runner.ts";
import { closeIfUndecidable } from "./open-decisions.ts";
import { resolvePathRewrite } from "./patch-apply.ts";
import { persistPatchCandidate } from "./persist-candidate.ts";
import { resolvePolicy, shouldAutoApply } from "./policy.ts";
import { buildDryRunStep, loadStepSnapshot } from "./step-snapshot.ts";
import {
  candidateProposal,
  findActiveEndpointCandidate,
  findMatchingTerminalEndpointCandidate,
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
  step_snapshot?: FailingStepSnapshot;
}

export type SignalSource = "reactive" | "proactive_scheduler" | "proactive_admin" | "proactive_mcp";

export interface SignalContext {
  tenant_id: string;
  workflow_id: string;
  execution_id: string | null;
  step_id: string | null;
  workflow_step_id?: string | null;
  connector_id?: string | null;
  endpoint_key?: string | null;
  actor_id: string | null;
  actor_type?: AuditActorType;
  source: SignalSource;
  scan_id?: string;
  repair_input: {
    failing_step_id: string;
    request?: unknown;
    response?: unknown;
  };
  dry_run_step?: DryRunStep;
}

export interface ProcessSignalOptions {
  allowAutoApply: boolean;
}

export interface ProcessSignalResult {
  candidate_id: string;
  classification: "safe" | "unsafe";
  status: "proposed" | "applied" | "rejected" | "superseded" | "inapplicable";
  auto_applied: boolean;
  dry_run_passed: boolean | null;
  proposal: PatchProposal;
  created: boolean;
  policy: import("./policy.ts").AutohealPolicy;
}

async function failedRunEnvironment(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<"dev" | "prod" | null> {
  const [row] = await db
    .select({ environment: executions.execution_mode })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  return row?.environment ?? null;
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

async function refreshOrSkipExistingCandidate(
  db: Db,
  existing: typeof patchCandidates.$inferSelect,
  ctx: SignalContext,
  options: ProcessSignalOptions,
): Promise<ProcessSignalResult | null> {
  const diff = (existing.diff ?? {}) as Record<string, unknown>;
  const proposal = diff.proposal as PatchProposal | undefined;
  if (!proposal) return null;

  const policy = await resolvePolicy(ctx.tenant_id, ctx.workflow_id, db);

  if (existing.status === "applied") {
    if (ctx.source === "reactive") {
      logger.warn({
        module: "self-healing",
        action: "patch.applied_but_recurred",
        msg: "drift recurred reactively after an applied patch — proposing a fresh candidate",
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        patch_candidate_id: existing.id,
        connector_id: ctx.connector_id ?? null,
        endpoint_key: ctx.endpoint_key ?? null,
      });
      return null;
    }
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
      created: false,
    };
  }

  const wouldAutoApply = shouldAutoApply({
    policy,
    classification: existing.classification,
    fixture_passed: false,
    has_fixture: false,
  });
  const autoApply = options.allowAutoApply && wouldAutoApply;

  let closed = false;
  const appliedVersionId = await db.transaction(async (tx) => {
    const outcome = autoApply
      ? await autoApplyPatch(tx, {
          tenant_id: ctx.tenant_id,
          workflow_id: ctx.workflow_id,
          candidate_id: existing.id,
          proposal,
        })
      : null;
    if (!outcome?.applied) {
      if (outcome) logPatchNotApplied(ctx, existing.id, outcome.reason, "proactive_refresh");
      closed = await closeIfUndecidable(tx, existing, "proactive_refresh");
      return null;
    }
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
          new_workflow_version_id: outcome.version_id,
          changed_paths: outcome.changed_paths,
          classification: existing.classification,
          policy,
          source: ctx.source,
          via: "proactive_refresh",
        },
      },
      tx,
    );
    await writeEvent(tx, {
      tenant_id: ctx.tenant_id,
      channel: "notification.emitted",
      type: "patch.applied",
      payload: {
        patch_candidate_id: existing.id,
        workflow_id: ctx.workflow_id,
        workflow_version_id: outcome.version_id,
        changed_paths: outcome.changed_paths,
        auto_applied: true,
      },
    });
    return outcome.version_id;
  });

  const auto_applied = !!appliedVersionId;
  if (!closed)
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
    status: auto_applied ? "applied" : closed ? "inapplicable" : "proposed",
    auto_applied,
    dry_run_passed: null,
    proposal,
    policy,
    created: false,
  };
}

export async function processDriftSignal(
  signal: DriftSignal,
  ctx: SignalContext,
  options: ProcessSignalOptions,
  exec?: Db,
): Promise<ProcessSignalResult> {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const workflow = await lockWorkflowForVersionWrite(tx, ctx.tenant_id, ctx.workflow_id);
    return processDriftSignalLocked(
      signal,
      ctx,
      options,
      tx as unknown as Db,
      workflow?.current_version_id ?? null,
    );
  });
}

async function processDriftSignalLocked(
  signal: DriftSignal,
  ctx: SignalContext,
  options: ProcessSignalOptions,
  db: Db,
  baseVersionId: string | null,
): Promise<ProcessSignalResult> {
  const existing = await findActiveEndpointCandidate(db, {
    tenant_id: ctx.tenant_id,
    workflow_id: ctx.workflow_id,
    connector_id: ctx.connector_id ?? null,
    endpoint_key: ctx.endpoint_key ?? null,
    signal,
    base_version_id: baseVersionId,
    workflow_step_id: ctx.workflow_step_id ?? null,
  });
  if (existing) {
    const dedup = await refreshOrSkipExistingCandidate(db, existing, ctx, options);
    if (dedup) return dedup;
  }
  const terminal = await findMatchingTerminalEndpointCandidate(db, {
    tenant_id: ctx.tenant_id,
    workflow_id: ctx.workflow_id,
    connector_id: ctx.connector_id ?? null,
    endpoint_key: ctx.endpoint_key ?? null,
    signal,
    base_version_id: baseVersionId,
    workflow_step_id: ctx.workflow_step_id ?? null,
    step_id: ctx.step_id,
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
      created: false,
    };
  }

  const diff = renderDriftDiff(signal);
  const fixture = await loadFixture(
    ctx.tenant_id,
    ctx.connector_id ?? null,
    ctx.endpoint_key ?? null,
    db,
  );

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
          execution_id: ctx.execution_id ?? null,
          ...(ctx.scan_id ? { scan_id: ctx.scan_id } : {}),
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
    const executable = resolvePathRewrite(proposal) !== null;
    if (classifierOk && fixtureOk && executable) break;

    const reason = !executable
      ? "No executable patch: use update_field_path with an exact old path and new path value; schema descriptions cannot change a workflow."
      : !classifierOk && !fixtureOk
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

  const environment = ctx.execution_id
    ? await failedRunEnvironment(db, ctx.tenant_id, ctx.execution_id)
    : null;
  let closed = false;
  const txOut = await db.transaction(async (tx) => {
    const gatedFixtureId = fixture && ctx.dry_run_step ? fixture.id : null;
    const persisted = await persistPatchCandidate(tx, {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      connector_id: ctx.connector_id ?? null,
      endpoint_key: ctx.endpoint_key ?? null,
      classification: decision.classification,
      fixture_id: gatedFixtureId,
      diff: {
        base_version_id: baseVersionId,
        drift_signal: signal,
        drift_diff: diff,
        proposal,
        classification_reasons: decision.reasons,
        dry_run: {
          ok: dryRunOk,
          error: dryRunError ?? null,
          fixture_id: fixture?.id ?? null,
          skipped: !ctx.dry_run_step || !fixture,
        },
        policy,
        step_id: ctx.step_id,
        workflow_step_id: ctx.workflow_step_id ?? null,
        execution_id: ctx.execution_id,
        ...(environment ? { environment } : {}),
        source: ctx.source,
        ...(ctx.scan_id ? { scan_id: ctx.scan_id } : {}),
        ...(rejectionChain.length > 0 ? { rejection_chain: rejectionChain } : {}),
      },
      audit_metadata: {
        policy,
        ...(ctx.actor_type ? { initiating_actor: { type: ctx.actor_type, id: ctx.actor_id } } : {}),
        drift_kind: signal.kind,
        fixture_id: gatedFixtureId,
        dry_run_ok: dryRunOk,
        dry_run_skipped: !ctx.dry_run_step || !fixture,
        reasons: decision.reasons,
        source: ctx.source,
        ...(ctx.scan_id ? { scan_id: ctx.scan_id } : {}),
      },
      event_payload: {
        policy,
        dry_run_ok: dryRunOk,
        source: ctx.source,
        ...(ctx.scan_id ? { scan_id: ctx.scan_id } : {}),
      },
      log_fields: { policy, dry_run_ok: dryRunOk, auto_apply: autoApply },
    });
    const candidate = persisted.candidate;
    closed = persisted.closed;
    if (closed) return { candidate, appliedVersionId: null };

    let appliedVersionId: string | null = null;
    if (autoApply) {
      const outcome = await autoApplyPatch(tx, {
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        candidate_id: candidate.id,
        proposal,
      });
      if (!outcome.applied) {
        logPatchNotApplied(ctx, candidate.id, outcome.reason, decision.classification);
        closed = await closeIfUndecidable(tx, candidate, "auto_apply");
      } else {
        appliedVersionId = outcome.version_id;
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
              new_workflow_version_id: outcome.version_id,
              changed_paths: outcome.changed_paths,
              fixture_id: gatedFixtureId,
              classification: decision.classification,
              policy,
              source: ctx.source,
            },
          },
          tx,
        );
        await writeEvent(tx, {
          tenant_id: ctx.tenant_id,
          channel: "notification.emitted",
          type: "patch.applied",
          payload: {
            patch_candidate_id: candidate.id,
            workflow_id: ctx.workflow_id,
            workflow_version_id: outcome.version_id,
            changed_paths: outcome.changed_paths,
            auto_applied: true,
          },
        });
      }
    }
    return { candidate, appliedVersionId };
  });

  const auto_applied = !!txOut.appliedVersionId;
  if (!closed)
    recordPatchCandidate({
      classification: decision.classification,
      decision: auto_applied ? "auto_applied" : "parked",
    });
  recordLoopDriftToPatchCandidate({
    tenant_id: ctx.tenant_id,
    classifier: decision.classification,
  });
  if (!closed)
    logger.info({
      module: "self-healing",
      action: auto_applied ? "patch.auto_applied" : "patch.parked",
      msg: auto_applied
        ? "self-healing auto-applied patch"
        : "self-healing parked patch for review",
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
    status: auto_applied ? "applied" : closed ? "inapplicable" : "proposed",
    auto_applied,
    dry_run_passed: fixture && ctx.dry_run_step ? dryRunOk : null,
    proposal,
    policy,
    created: true,
  };
}

export async function runSelfHealingLoop(
  params: RunSelfHealingParams,
  exec?: Db,
): Promise<SelfHealingResult> {
  const db = exec ?? getDb();

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

  let lastShape = null;
  if (params.connector_id && params.endpoint_key) {
    const requestConnector =
      snapshot.request_meta && "connector" in snapshot.request_meta
        ? snapshot.request_meta.connector
        : null;
    const workflowStepId = requestConnector?.step_key ?? snapshot.step_key;
    lastShape = await getLatestShape(
      {
        tenant_id: params.tenant_id,
        connector_id: params.connector_id,
        endpoint_key: params.endpoint_key,
        ...(workflowStepId ? { workflow_id: params.workflow_id, step_id: workflowStepId } : {}),
      },
      db,
    );
  }

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

  if (snapshot.output_preview === null) {
    logger.warn({
      module: "self-healing",
      action: "repair.unpatchable_null_output",
      msg: "failing step returned null — no definition patch can fix a null runtime output; parked for human review",
      needs_review: true,
      tenant_id: params.tenant_id,
      workflow_id: params.workflow_id,
      step_id: params.step_id,
      execution_id: params.execution_id,
    });
    return emptyResult("unpatchable: failing step returned null output — needs human review");
  }

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
