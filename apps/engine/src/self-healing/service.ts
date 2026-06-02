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
//     tool). Proactive callers pass `allowAutoApply: false` so the
//     resulting Patch Candidate is always parked for operator review,
//     no matter how clean the classification + fixture dry-run come
//     out. This preserves the human-in-the-loop guarantee that
//     proactive scans never silently mutate a tenant's workflows.
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
  recordLoopDriftToPatchCandidate,
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
   * of classification, fixture dry-run, or policy. Proactive callers
   * (scheduler tick, admin HTTP, MCP tool) pass false. Reactive
   * callers pass true and the existing policy/classification/fixture
   * gates decide whether `autoApplyPatch` runs.
   */
  allowAutoApply: boolean;
}

export interface ProcessSignalResult {
  candidate_id: string;
  classification: "safe" | "unsafe";
  status: "proposed" | "applied";
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
  tenant_id: string,
  step_id: string,
  exec: Executor,
): Promise<FailingStepSnapshot | null> {
  const rows = await exec
    .select()
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.id, step_id)))
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
  const wfRows = await tx
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, params.tenant_id), eq(workflows.id, params.workflow_id)))
    .limit(1);
  const wf = wfRows[0];
  if (!wf?.current_version_id) return null;

  const cvRows = await tx
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, params.tenant_id),
        eq(workflowVersions.id, wf.current_version_id),
      ),
    )
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

  const maxRows = (await tx
    .select({
      max_version: workflowVersions.version,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, params.tenant_id),
        eq(workflowVersions.workflow_id, params.workflow_id),
      ),
    )
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

/**
 * Turn a recognised drift signal into a persisted Patch Candidate.
 *
 * Reactive callers (the pg-boss `workflow.repair` handler) pass
 * `allowAutoApply: true` and the existing classification + fixture +
 * policy gates decide whether the patch auto-applies.
 *
 * Proactive callers (scheduler tick, admin POST, MCP) pass
 * `allowAutoApply: false`. The Patch Candidate is always persisted
 * in `status='proposed'` and the existing approve/reject HTTP routes
 * remain the sole apply path.
 */
export async function processDriftSignal(
  signal: DriftSignal,
  ctx: SignalContext,
  options: ProcessSignalOptions,
  exec?: Db,
): Promise<ProcessSignalResult> {
  const db = exec ?? getDb();

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
  // Opening edge of the Run → Drift → Patch → Skill loop (positioning.md §6):
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
