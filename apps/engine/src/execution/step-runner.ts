// Per-step orchestration: applies the configured data_selector to the
// raw step result, applies offload, persists the step row, and emits the
// debug log. Drivers (request, transform, ...) own the actual work and
// the retry loops; this file owns the surrounding ceremony.

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { log, logger } from "../logging/logger.ts";
import { readWorkflowState, writeWorkflowState } from "../workflow-state/service.ts";
import type { StepDef } from "../workflows/types.ts";
import { maybeOffload, previewOf } from "./offload.ts";
import { applySelector } from "./selectors.ts";
import { finalizeStepRow } from "./state.ts";
import { runBranchStep } from "./steps/branch.ts";
import { runLoopStep } from "./steps/loop.ts";
import { runParallelStep } from "./steps/parallel.ts";
import { runRequestStep } from "./steps/request.ts";
import { runToolStep } from "./steps/tool.ts";
import { runTransformStep } from "./steps/transform.ts";
import { runWaitStep } from "./steps/wait.ts";
import { runWaitForEventStep } from "./steps/wait-for-event.ts";
import type { StepResult, StepRunContext } from "./types.ts";

// Workstream #51: persistent workflow state — `state_read` binds a
// tenant-encrypted value into the substitution scope under the chosen
// `into_var`; `state_write` persists a dot-path slice of the step
// result back to the same store after the step succeeds.
//
// `into_var` collisions with an existing step id are not blocked at
// schema level — the binding here uses a dedicated key on the scope
// object, so a colliding step id would be shadowed for the duration of
// this step. Recipes should pick a distinct `into_var` (e.g. `since`,
// `last_seen_at`).
function resolveDotPath(value: unknown, dotPath: string): unknown {
  if (!dotPath) return value;
  let cur: unknown = value;
  for (const segment of dotPath.split(".")) {
    if (segment === "") continue;
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

export interface RunStepOutcome {
  result: StepResult;
  // The value to expose to downstream steps (after data_selector projection).
  scope_value: unknown;
  /**
   * Pre-data_selector raw output. Set only when the step actually
   * declared a `data_selector` (so the value differs from
   * `scope_value`); otherwise omitted to avoid duplicating the same
   * preview twice. The engine surfaces this on `step_trace[i].raw_preview`
   * so the LLM can see what the selector dropped without re-running.
   */
  raw_output?: unknown;
}

// Workstream A7: redact step output keys the recipe declared as
// `outputs[k].secret = true`. The marker matches the shared
// `isAlreadyRedacted` regex so downstream scrubber passes leave it
// alone. Only request steps carry the `outputs` declaration today
// (the only kind whose external response can contain credentials);
// other step kinds bypass cleanly.
function applyDeclaredSecrets(step: StepDef, value: unknown): unknown {
  if (step.kind !== "request") return value;
  const outputs = (step as { outputs?: Record<string, { secret?: boolean }> }).outputs;
  if (!outputs) return value;
  const secretKeys = Object.entries(outputs)
    .filter(([, v]) => v?.secret === true)
    .map(([k]) => k);
  if (secretKeys.length === 0) return value;
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of secretKeys) {
    if (key in out) out[key] = "***REDACTED:secret_output***";
  }
  return out;
}

export async function runStep(
  ctx: StepRunContext,
  scope: Record<string, unknown>,
  workflowInput: unknown,
  callRunner: (sub: { ctx: StepRunContext; step: StepDef }) => Promise<StepResult>,
): Promise<RunStepOutcome> {
  const step = ctx.step;
  let result: StepResult;

  // #51 state_read: bind a persistent value into substitution scope
  // BEFORE the step runs. Defaults to `state_read.default_value`
  // (commonly `null`) when the row does not exist yet — the canonical
  // first-run case for cursor-based reverse-ETL.
  if (step.kind === "request" && step.state_read) {
    const sr = step.state_read;
    try {
      const row = await readWorkflowState(ctx.db, ctx.tenant_id, ctx.workflow_id, sr.key);
      const bound = row !== undefined ? row.value : (sr.default_value ?? null);
      // Bind under `scope.$state[into_var]` so the substitution resolver
      // surfaces it via `${state.<into_var>}` / `${state.<into_var>.<path>}`
      // (parser kind: "state"). Mirrors the `$item` convention used by
      // the loop step.
      const existingState = (scope.$state as Record<string, unknown> | undefined) ?? {};
      scope.$state = { ...existingState, [sr.into_var]: bound };
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "system",
          action: AuditAction.STATE_READ,
          resource_type: "workflow",
          resource_id: ctx.workflow_id,
          result: "success",
          metadata: {
            execution_id: ctx.execution_id,
            step_id: step.id,
            key: sr.key,
            into_var: sr.into_var,
            had_value: row !== undefined,
          },
        },
        ctx.db,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "system",
          action: AuditAction.STATE_READ,
          resource_type: "workflow",
          resource_id: ctx.workflow_id,
          result: "error",
          reason: message,
          metadata: {
            execution_id: ctx.execution_id,
            step_id: step.id,
            key: sr.key,
          },
        },
        ctx.db,
      );
      result = {
        status: "failed",
        retry_count: 0,
        duration_ms: 0,
        error: { code: "state_read_failed", message },
      };
      // Skip the actual step and fall through to the post-run pipeline.
      // The scope_value falls back to undefined so downstream steps
      // see no result.
      const scope_value = undefined;
      const scrubbedScope = applyDeclaredSecrets(step, scope_value);
      const offload = await maybeOffload(ctx.db, {
        tenant_id: ctx.tenant_id,
        execution_id: ctx.execution_id,
        step_id: ctx.step_row_id,
        result: scrubbedScope ?? null,
      });
      await finalizeStepRow(ctx.db, ctx.step_row_id, result.status, result, {
        output_preview: offload.storage_uri ? null : (scrubbedScope ?? null),
        result_preview: offload.preview ?? previewOf(scrubbedScope ?? null),
        result_storage_uri: offload.storage_uri,
      });
      log.execution.step.failed({
        step_id: step.id,
        kind: step.kind,
        duration_ms: result.duration_ms,
        error_code: result.error?.code,
        error_msg: result.error?.message,
        execution_id: ctx.execution_id,
      });
      return { result, scope_value };
    }
  }

  switch (step.kind) {
    case "request":
      result = await runRequestStep({ ctx, step, scope });
      break;
    case "transform":
      result = await runTransformStep({ ctx, step, scope, input: workflowInput });
      break;
    case "wait":
      result = await runWaitStep({ ctx, step });
      break;
    case "wait_for_event":
      result = await runWaitForEventStep({ ctx, step });
      break;
    case "branch":
      result = await runBranchStep({ ctx, step, scope });
      break;
    case "parallel":
      result = await runParallelStep({ ctx, step });
      break;
    case "loop":
      result = await runLoopStep({ ctx, step, scope });
      break;
    case "call":
      result = await callRunner({ ctx, step });
      break;
    case "tool":
      result = await runToolStep({ ctx, step });
      break;
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
      result = {
        status: "failed",
        retry_count: 0,
        duration_ms: 0,
        error: { code: "unknown_step_kind", message: "unknown step kind" },
      };
    }
  }

  // #51 state_write: persist a dot-path slice of the step result AFTER
  // the step succeeds. Failures here propagate as a step failure so the
  // watermark and the side-effect cannot diverge silently — better to
  // re-run the workflow than to advance a watermark whose write was
  // dropped on the floor.
  if (result.status === "succeeded" && step.kind === "request" && step.state_write) {
    const sw = step.state_write;
    const sliced = resolveDotPath(result.output, sw.value_path);
    try {
      await writeWorkflowState(ctx.db, {
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        key: sw.key,
        value: sliced ?? null,
      });
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "system",
          action: AuditAction.STATE_WRITE,
          resource_type: "workflow",
          resource_id: ctx.workflow_id,
          result: "success",
          metadata: {
            execution_id: ctx.execution_id,
            step_id: step.id,
            key: sw.key,
            value_path: sw.value_path,
            value_kind:
              sliced === null
                ? "null"
                : sliced === undefined
                  ? "undefined"
                  : Array.isArray(sliced)
                    ? "array"
                    : typeof sliced,
          },
        },
        ctx.db,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "system",
          action: AuditAction.STATE_WRITE,
          resource_type: "workflow",
          resource_id: ctx.workflow_id,
          result: "error",
          reason: message,
          metadata: {
            execution_id: ctx.execution_id,
            step_id: step.id,
            key: sw.key,
          },
        },
        ctx.db,
      );
      result = {
        ...result,
        status: "failed",
        error: { code: "state_write_failed", message },
      };
    }
  }

  if (result.status === "succeeded") {
    log.execution.step.completed({
      step_id: step.id,
      kind: step.kind,
      duration_ms: result.duration_ms,
      execution_id: ctx.execution_id,
    });
  } else if (result.status === "failed") {
    log.execution.step.failed({
      step_id: step.id,
      kind: step.kind,
      duration_ms: result.duration_ms,
      error_code: result.error?.code,
      error_msg: result.error?.message,
      execution_id: ctx.execution_id,
    });
  } else if (result.status === "timed_out") {
    log.execution.step.timeout({
      step_id: step.id,
      kind: step.kind,
      duration_ms: result.duration_ms,
      error_code: result.error?.code,
      execution_id: ctx.execution_id,
    });
  }

  let scope_value = result.output;
  let raw_output: unknown;
  if (result.status === "succeeded" && step.data_selector) {
    raw_output = result.output;
    try {
      scope_value = applySelector(step.data_selector, result.output);
    } catch (err) {
      result = {
        ...result,
        status: "failed",
        error: {
          code: "data_selector_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
      scope_value = undefined;
    }
  }

  // Workstream A7: scrub declared-secret outputs BEFORE offload + preview
  // so the redacted payload reaches downstream readers (offload storage,
  // step preview, audit log, structured logs). The recipe author marks
  // `outputs[k].secret = true` (e.g. on Cognito IdToken / OAuth2
  // access_token); the executor replaces those keys with the standard
  // ***REDACTED:secret_output*** marker that already passes the
  // existing scrubber's "isAlreadyRedacted" check.
  const scrubbedScope = applyDeclaredSecrets(step, scope_value);

  // Offload + preview
  const offload = await maybeOffload(ctx.db, {
    tenant_id: ctx.tenant_id,
    execution_id: ctx.execution_id,
    step_id: ctx.step_row_id,
    result: scrubbedScope ?? result.output ?? null,
  });

  // When the step produced non-fatal warnings, persist them alongside
  // the preview so downstream readers (execution_fixtures exporter,
  // self-healing, operator UI) see them without re-running the step.
  const warnings = result.warnings && result.warnings.length > 0 ? result.warnings : null;
  const output_preview = offload.storage_uri
    ? null
    : warnings
      ? { value: scrubbedScope ?? null, warnings }
      : (scrubbedScope ?? null);
  await finalizeStepRow(ctx.db, ctx.step_row_id, result.status, result, {
    output_preview,
    result_preview: offload.preview ?? previewOf(scrubbedScope ?? null),
    result_storage_uri: offload.storage_uri,
  });

  logger.debug({
    module: "execution",
    action: "execution.step",
    msg: `step ${step.id} ${result.status}`,
    execution_id: ctx.execution_id,
    step_index: ctx.step_index,
    kind: step.kind,
    status: result.status,
    duration_ms: result.duration_ms,
    retry_count: result.retry_count,
    bytes_out: offload.size_bytes,
  });

  return {
    result,
    scope_value,
    ...(raw_output !== undefined ? { raw_output } : {}),
  };
}
