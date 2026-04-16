// Execution engine entry point. `runExecution` walks the steps in
// declaration order (no DAG topo-sort yet — P3 ships linear pipelines
// plus branch/parallel/loop control hints). It:
//
//   1. creates an `executions` row (status=queued)
//   2. registers an AbortController under the execution id
//   3. transitions to `running` and emits `execution.started`
//   4. for each step: inserts an execution_steps row, runs the driver via
//      step-runner, applies onError semantics
//   5. transitions to a terminal state, audits + outbox-events, releases
//      the AbortController
//
// Tool chaining: a `call` step looks up the target workflow + version,
// invokes runExecution recursively with parent_execution_id set,
// request_source='tool-chain' and depth+1.

import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import {
  type CallStep,
  type StepDef,
  type WorkflowDef,
  WorkflowDefSchema,
} from "../workflows/types.ts";
import { combineSignals, registerAbort, unregisterAbort } from "./abort.ts";
import { maybeOffload, previewOf } from "./offload.ts";
import {
  createExecution,
  finalizeExecution,
  insertStepRow,
  markExecutionRunning,
} from "./state.ts";
import { runStep } from "./step-runner.ts";
import {
  type ExecutionStatus,
  MAX_CALL_DEPTH,
  type RequestSource,
  type RunOptions,
  type RunResult,
  type StepResult,
  type StepRunContext,
} from "./types.ts";

const WORKFLOW_TIMEOUT_DEFAULT_MS = 6 * 60 * 60_000;

export interface RunExecutionParams {
  db: Db;
  tenant_id: string;
  workflow_id: string;
  input: unknown;
  options?: RunOptions;
}

export async function runExecution(p: RunExecutionParams): Promise<RunResult> {
  const { db, tenant_id, workflow_id } = p;
  const opts: RunOptions = p.options ?? {};
  const depth = opts.depth ?? 0;
  if (depth > MAX_CALL_DEPTH) {
    throw new Error(`call chain depth exceeded ${MAX_CALL_DEPTH}`);
  }
  // Resolve workflow + current version.
  const wfRows = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const wfRow = wfRows[0];
  if (!wfRow) throw new Error(`workflow not found: ${workflow_id}`);
  if (!wfRow.current_version_id) throw new Error("workflow has no current version");
  const versionRows = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, wfRow.current_version_id))
    .limit(1);
  const versionRow = versionRows[0];
  if (!versionRow) throw new Error("workflow version not found");
  const def = WorkflowDefSchema.parse(versionRow.dag);

  const request_source: RequestSource = opts.request_source ?? "api";
  const parent_execution_id = opts.parent_execution_id ?? null;
  const execution_mode = opts.execution_mode ?? "dev";

  // Persist queued execution row (unless one already exists — the queue
  // worker passes `existing_execution_id` so the HTTP-created row is
  // reused instead of spawning a new one).
  const execution_id = opts.existing_execution_id
    ? opts.existing_execution_id
    : await createExecution(db, {
        tenant_id,
        workflow_id,
        workflow_version_id: versionRow.id,
        request_source,
        parent_execution_id,
        execution_mode,
      });

  await auditAwait(
    {
      tenant_id,
      actor_type: "system",
      action: AuditAction.EXECUTION_STARTED,
      resource_type: "execution",
      resource_id: execution_id,
      result: "success",
      metadata: { workflow_id, request_source, parent_execution_id },
    },
    db,
  );

  // Wire abort: external signal (if any) feeds into the per-execution
  // controller. The controller is registered so cancel API can find it.
  const ctrl = registerAbort(execution_id);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort("aborted");
    else opts.signal.addEventListener("abort", () => ctrl.abort("aborted"), { once: true });
  }
  const totalTimeoutCtrl = new AbortController();
  const totalTimer = setTimeout(
    () => totalTimeoutCtrl.abort("workflow_timeout"),
    def.timeout_ms ?? WORKFLOW_TIMEOUT_DEFAULT_MS,
  );
  const signal = combineSignals([ctrl.signal, totalTimeoutCtrl.signal]);

  await markExecutionRunning(db, tenant_id, execution_id);

  const scope: Record<string, unknown> = { $input: p.input };
  let finalStatus: ExecutionStatus = "succeeded";
  const stepSummaries: RunResult["steps"] = [];
  let lastOutput: unknown = null;
  let lastError: { code: string; message: string } | null = null;

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i] as StepDef;
    if (signal.aborted) {
      // Drain remaining steps as aborted summary entries.
      stepSummaries.push({
        step_key: step.id,
        step_index: i,
        kind: step.kind,
        status: "aborted",
        duration_ms: 0,
        retry_count: 0,
        error: { code: "aborted", message: "execution aborted" },
      });
      continue;
    }
    const step_row_id = await insertStepRow(db, {
      tenant_id,
      execution_id,
      step_key: step.id,
      step_index: i,
      kind: step.kind,
    });
    const ctx: StepRunContext = {
      db,
      tenant_id,
      execution_id,
      workflow_id,
      workflow_version_id: versionRow.id,
      request_source,
      parent_execution_id,
      depth,
      signal,
      scope,
      started_at: new Date(),
      workflow_slug: wfRow.slug,
      trace_id: opts.trace_id ?? null,
      principal: opts.principal ?? null,
      execution_mode,
      step,
      step_index: i,
      step_row_id,
    };
    let outcome: import("./step-runner.ts").RunStepOutcome;
    try {
      outcome = await runStep(ctx, scope, p.input, async ({ ctx: cctx, step: cstep }) =>
        runCallStep(db, cctx, cstep as CallStep),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({
        module: "execution",
        action: "execution.step_crash",
        msg: "step driver threw",
        execution_id,
        step_id: step.id,
        error: message,
      });
      outcome = {
        result: {
          status: "failed" as const,
          retry_count: 0,
          duration_ms: 0,
          error: { code: "step_crash", message },
        },
        scope_value: undefined,
      };
    }
    scope[step.id] = outcome.scope_value;
    lastOutput = outcome.scope_value;
    stepSummaries.push({
      step_key: step.id,
      step_index: i,
      kind: step.kind,
      status: outcome.result.status,
      duration_ms: outcome.result.duration_ms ?? null,
      retry_count: outcome.result.retry_count ?? 0,
      error: outcome.result.error ?? null,
    });
    if (outcome.result.status !== "succeeded") {
      const onError = step.on_error ?? "fail";
      lastError = outcome.result.error ?? { code: "step_failed", message: "step failed" };
      if (onError === "fail") {
        if (outcome.result.status === "aborted") finalStatus = "aborted";
        else if (outcome.result.status === "timed_out") finalStatus = "timed_out";
        else finalStatus = "failed";
        // mark remaining steps aborted in summary
        for (let j = i + 1; j < def.steps.length; j++) {
          const s = def.steps[j] as StepDef;
          stepSummaries.push({
            step_key: s.id,
            step_index: j,
            kind: s.kind,
            status: "aborted",
            duration_ms: 0,
            retry_count: 0,
            error: { code: "skipped", message: "skipped due to upstream failure" },
          });
        }
        break;
      }
      // continue mode: keep scope value, mark continue
    }
  }

  clearTimeout(totalTimer);
  // Re-evaluate finalStatus if total timeout fired.
  if (totalTimeoutCtrl.signal.aborted && finalStatus === "succeeded") {
    finalStatus = "timed_out";
  }
  if (ctrl.signal.aborted && finalStatus === "succeeded") {
    finalStatus = "aborted";
  }

  // Offload top-level execution result.
  const offload = await maybeOffload(db, {
    tenant_id,
    execution_id,
    step_id: null,
    result: lastOutput ?? null,
  });
  void previewOf; // re-export safety

  await finalizeExecution(db, tenant_id, execution_id, finalStatus, offload.storage_uri);
  await auditAwait(
    {
      tenant_id,
      actor_type: "system",
      action:
        finalStatus === "succeeded"
          ? AuditAction.EXECUTION_COMPLETED
          : finalStatus === "aborted"
            ? AuditAction.EXECUTION_ABORTED
            : AuditAction.EXECUTION_COMPLETED,
      resource_type: "execution",
      resource_id: execution_id,
      result: finalStatus === "succeeded" ? "success" : "error",
      metadata: { final_status: finalStatus, workflow_id },
    },
    db,
  );

  unregisterAbort(execution_id);

  return {
    execution_id,
    status: finalStatus,
    output: lastOutput,
    error: lastError,
    steps: stepSummaries,
  };
}

async function runCallStep(db: Db, ctx: StepRunContext, step: CallStep): Promise<StepResult> {
  const start = Date.now();
  if (ctx.depth + 1 > MAX_CALL_DEPTH) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "call_depth_exceeded", message: `max call depth ${MAX_CALL_DEPTH}` },
    };
  }
  // Resolve target workflow id by id or slug.
  let targetId: string | undefined = step.workflow_id;
  if (!targetId && step.workflow_slug) {
    const rows = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, step.workflow_slug),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    targetId = rows[0]?.id;
  }
  if (!targetId) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "call_target_missing", message: "workflow not found" },
    };
  }
  try {
    const child = await runExecution({
      db,
      tenant_id: ctx.tenant_id,
      workflow_id: targetId,
      input: step.input ?? null,
      options: {
        request_source: "tool-chain",
        parent_execution_id: ctx.execution_id,
        depth: ctx.depth + 1,
        signal: ctx.signal,
        trace_id: ctx.trace_id ?? null,
        execution_mode: ctx.execution_mode,
        ...(ctx.principal ? { principal: ctx.principal } : {}),
      },
    });
    return {
      status: child.status === "succeeded" ? "succeeded" : "failed",
      output: { execution_id: child.execution_id, status: child.status, output: child.output },
      retry_count: 0,
      duration_ms: Date.now() - start,
      error:
        child.status === "succeeded"
          ? null
          : (child.error ?? { code: "child_failed", message: `child status ${child.status}` }),
    };
  } catch (err) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "call_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export type { WorkflowDef };
// Re-export the schema so consumers (workflow service) can validate.
export { WorkflowDefSchema };
