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
import { workflows } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { recordExecutionOutcome } from "../self-healing/outcome-tracker.ts";
import {
  type BranchStep,
  type CallStep,
  type LoopStep,
  type ParallelStep,
  type StepDef,
  type WorkflowDef,
  WorkflowDefSchema,
} from "../workflows/types.ts";

import { combineSignals, registerAbort, unregisterAbort } from "./abort.ts";
import { maybeOffload, previewOf } from "./offload.ts";
import { type RunExecutionSource, resolveDefinition } from "./resolve-definition.ts";
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

function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const required = schema.required as string[] | undefined;
  if (required && Array.isArray(required) && typeof value === "object" && value !== null) {
    for (const field of required) {
      if (!(field in (value as Record<string, unknown>))) {
        errors.push(`${location}: required field '${field}' is missing`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

const WORKFLOW_TIMEOUT_DEFAULT_MS = 6 * 60 * 60_000;

/** Envelope shape exposed on `scope[step.id]`. Transform expressions
 *  read `$scope.<id>.data` for the payload and `$scope.<id>.status_code`
 *  / `$scope.<id>.headers` / `$scope.<id>.error` / `$scope.<id>.duration_ms`
 *  for diagnostics. Matches the contract documented in the
 *  data-handling skill. */
export interface ScopeEnvelope {
  data: unknown;
  status_code?: number;
  headers?: Record<string, string>;
  duration_ms: number;
  error: { code: string; message: string; details?: unknown } | null;
}

function wrapEnvelope(params: {
  data: unknown;
  duration_ms: number;
  error: { code: string; message: string; details?: unknown } | null;
  request_meta?: Record<string, unknown> | null;
}): ScopeEnvelope {
  const env: ScopeEnvelope = {
    data: params.data ?? null,
    duration_ms: params.duration_ms,
    error: params.error ?? null,
  };
  const rm = params.request_meta;
  if (rm && typeof rm === "object") {
    if (typeof rm.status === "number") env.status_code = rm.status;
    if (rm.headers && typeof rm.headers === "object") {
      env.headers = rm.headers as Record<string, string>;
    }
  }
  return env;
}

function envelopeFor(outcome: { result: StepResult; scope_value: unknown }): ScopeEnvelope {
  return wrapEnvelope({
    data: outcome.scope_value,
    duration_ms: outcome.result.duration_ms ?? 0,
    error: outcome.result.error ?? null,
    request_meta: outcome.result.request_meta ?? null,
  });
}

export interface RunExecutionParams {
  db: Db;
  tenant_id: string;
  /** Discriminated union: "saved" | "draft" | "step". The engine pipeline
   *  is identical for all three; only the origin differs. */
  source: RunExecutionSource;
  input: unknown;
  options?: RunOptions;
}

export async function runExecution(p: RunExecutionParams): Promise<RunResult> {
  const { db, tenant_id } = p;
  const opts: RunOptions = p.options ?? {};
  const depth = opts.depth ?? 0;
  if (depth > MAX_CALL_DEPTH) {
    throw new Error(`call chain depth exceeded ${MAX_CALL_DEPTH}`);
  }

  // Resolve the execution definition from one of three sources:
  //   saved — persisted workflow + current_version_id
  //   draft — inline WorkflowDef (validated, not persisted)
  //   step  — single StepDef wrapped as a one-step WorkflowDef
  const resolved = await resolveDefinition(db, tenant_id, p.source);
  const def = resolved.def;
  const workflow_id = resolved.workflow_id;
  const workflow_version_id = resolved.workflow_version_id;

  const request_source: RequestSource = opts.request_source ?? "api";
  const parent_execution_id = opts.parent_execution_id ?? null;
  const execution_mode = opts.execution_mode ?? "dev";

  // Persist queued execution row (unless one already exists — the queue
  // worker passes `existing_execution_id` so the HTTP-created row is
  // reused instead of spawning a new one). For draft / step runs the
  // workflow_id / workflow_version_id columns stay NULL.
  const execution_id = opts.existing_execution_id
    ? opts.existing_execution_id
    : await createExecution(db, {
        tenant_id,
        workflow_id: resolved.persist_workflow_refs ? workflow_id : null,
        workflow_version_id: resolved.persist_workflow_refs ? workflow_version_id : null,
        source_kind: resolved.source_kind,
        source_ref: resolved.source_ref,
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
      metadata: {
        workflow_id: resolved.persist_workflow_refs ? workflow_id : null,
        source_kind: resolved.source_kind,
        request_source,
        parent_execution_id,
      },
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

  if (def.input_schema && p.input !== undefined && p.input !== null) {
    const check = validateAgainstJsonSchema(p.input, def.input_schema, "$input");
    if (!check.valid) {
      throw Object.assign(new Error(check.errors.join("; ")), {
        code: "input_schema_violation",
        details: check.errors,
      });
    }
  }

  let finalStatus: ExecutionStatus = "succeeded";
  const stepSummaries: RunResult["steps"] = [];
  let lastOutput: unknown = null;
  let lastError: { code: string; message: string } | null = null;
  const skippedStepIds = new Set<string>();
  const warningsAccum: NonNullable<RunResult["warnings"]> = [];

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
    if (skippedStepIds.has(step.id)) {
      stepSummaries.push({
        step_key: step.id,
        step_index: i,
        kind: step.kind,
        status: "aborted",
        duration_ms: 0,
        retry_count: 0,
        error: { code: "skipped", message: "skipped by branch control flow" },
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
      workflow_version_id,
      request_source,
      parent_execution_id,
      depth,
      signal,
      scope,
      started_at: new Date(),
      workflow_slug: resolved.workflow_slug,
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
    // Wrap every step's output in the documented envelope
    //   { data, status_code?, headers?, duration_ms, error? }
    // so transforms can read `$scope.<id>.data` — the contract the
    // data-handling skill has promised forever but the runtime used to
    // ignore (stepId was the raw body). Loop/branch/parallel keep their
    // special array/record shape under `.data` too so authors can write
    // `$scope.each.data.length` etc. uniformly.
    scope[step.id] = envelopeFor(outcome);
    lastOutput = outcome.scope_value;
    if (outcome.result.warnings?.length) {
      for (const w of outcome.result.warnings) {
        warningsAccum.push({ ...w, step_key: step.id });
      }
    }

    // Branch control flow: mark skipped arm's steps so they are skipped in the
    // linear walk.
    if (step.kind === "branch" && outcome.result.status === "succeeded") {
      const arm = (outcome.result.output as { arm?: string })?.arm;
      const branchStep = step as BranchStep;
      const skip = arm === "then" ? (branchStep.else_steps ?? []) : (branchStep.then_steps ?? []);
      for (const skipId of skip) {
        skippedStepIds.add(skipId);
      }
    }

    // Loop iteration: after the loop driver resolves the collection, iterate
    // each item through the body steps sequentially.
    if (step.kind === "loop" && outcome.result.status === "succeeded") {
      const loopStep = step as LoopStep;
      const items = outcome.result.output;
      if (Array.isArray(items)) {
        const iterationResults: unknown[] = [];
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          const item = items[itemIdx];
          const childScope: Record<string, unknown> = {
            ...scope,
            [loopStep.item_var]: item,
            $loop_index: itemIdx,
          };
          const bodyResults: Record<string, unknown> = {};
          for (const bodyStepId of loopStep.body) {
            const bodyStep = def.steps.find((s) => s.id === bodyStepId) as StepDef | undefined;
            if (!bodyStep) continue;
            const bodyStepRowId = await insertStepRow(db, {
              tenant_id,
              execution_id,
              step_key: `${bodyStep.id}[${itemIdx}]`,
              step_index: i,
              kind: bodyStep.kind,
            });
            const bodyCtx: import("./types.ts").StepRunContext = {
              db,
              tenant_id,
              execution_id,
              workflow_id,
              workflow_version_id,
              request_source,
              parent_execution_id,
              depth,
              signal,
              scope: childScope,
              started_at: new Date(),
              workflow_slug: resolved.workflow_slug,
              trace_id: opts.trace_id ?? null,
              principal: opts.principal ?? null,
              execution_mode,
              step: bodyStep,
              step_index: i,
              step_row_id: bodyStepRowId,
            };
            const bodyOutcome = await runStep(
              bodyCtx,
              childScope,
              p.input,
              async ({ ctx: cctx, step: cstep }) => runCallStep(db, cctx, cstep as CallStep),
            );
            childScope[bodyStep.id] = envelopeFor(bodyOutcome);
            bodyResults[bodyStep.id] = envelopeFor(bodyOutcome);
          }
          iterationResults.push(bodyResults);
        }
        scope[step.id] = wrapEnvelope({
          data: iterationResults,
          duration_ms: outcome.result.duration_ms ?? 0,
          error: null,
        });
        lastOutput = iterationResults;
      }
      // Mark body step ids as skipped in the linear walk (they run inside the loop)
      for (const bodyStepId of loopStep.body) {
        skippedStepIds.add(bodyStepId);
      }
    }

    // Parallel fan-out: run each branch concurrently via Promise.all.
    if (step.kind === "parallel" && outcome.result.status === "succeeded") {
      const parallelStep = step as ParallelStep;
      const branchResults = await Promise.all(
        parallelStep.branches.map(async (branchStepIds) => {
          const branchScope: Record<string, unknown> = { ...scope };
          const branchOutput: Record<string, unknown> = {};
          for (const branchStepId of branchStepIds) {
            const branchStepDef = def.steps.find((s) => s.id === branchStepId) as
              | StepDef
              | undefined;
            if (!branchStepDef) continue;
            const branchStepRowId = await insertStepRow(db, {
              tenant_id,
              execution_id,
              step_key: branchStepId,
              step_index: i,
              kind: branchStepDef.kind,
            });
            const branchCtx: import("./types.ts").StepRunContext = {
              db,
              tenant_id,
              execution_id,
              workflow_id,
              workflow_version_id,
              request_source,
              parent_execution_id,
              depth,
              signal,
              scope: branchScope,
              started_at: new Date(),
              workflow_slug: resolved.workflow_slug,
              trace_id: opts.trace_id ?? null,
              principal: opts.principal ?? null,
              execution_mode,
              step: branchStepDef,
              step_index: i,
              step_row_id: branchStepRowId,
            };
            const branchOutcome = await runStep(
              branchCtx,
              branchScope,
              p.input,
              async ({ ctx: cctx, step: cstep }) => runCallStep(db, cctx, cstep as CallStep),
            );
            branchScope[branchStepId] = envelopeFor(branchOutcome);
            branchOutput[branchStepId] = envelopeFor(branchOutcome);
          }
          return branchOutput;
        }),
      );
      scope[step.id] = wrapEnvelope({
        data: branchResults,
        duration_ms: outcome.result.duration_ms ?? 0,
        error: null,
      });
      lastOutput = branchResults;
      // Mark parallel branch step ids as skipped in the linear walk
      for (const branchStepIds of parallelStep.branches) {
        for (const branchStepId of branchStepIds) {
          skippedStepIds.add(branchStepId);
        }
      }
    }

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

  if (def.output_schema && lastOutput !== undefined) {
    const check = validateAgainstJsonSchema(lastOutput, def.output_schema, "$output");
    if (!check.valid) {
      logger.warn({ msg: "output schema violation", errors: check.errors });
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
  // Closed-loop patch-candidate outcome tracking: every finalised
  // execution updates any open outcome window for this workflow so
  // operators can see whether a recently-applied patch actually
  // prevented recurrence. Best-effort — tracker swallows errors.
  await recordExecutionOutcome(
    {
      tenant_id,
      workflow_id,
      outcome: finalStatus === "succeeded" ? "success" : "failure",
    },
    db,
  );
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

  const runResult: RunResult = {
    execution_id,
    status: finalStatus,
    output: lastOutput,
    error: lastError,
    steps: stepSummaries,
  };
  if (warningsAccum.length > 0) runResult.warnings = warningsAccum;
  return runResult;
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
      source: { kind: "saved", workflow_id: targetId },
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

export type { RunExecutionSource, WorkflowDef };
// Re-export the schema so consumers (workflow service) can validate.
export { WorkflowDefSchema };
