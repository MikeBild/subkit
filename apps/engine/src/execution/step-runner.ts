import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type ResolvedFile, SPOOL_THRESHOLD_BYTES, walkAndResolve } from "../files/resolver.ts";
import { log, logger } from "../logging/index.ts";
import { readWorkflowState, writeWorkflowState } from "../workflow-state/index.ts";
import type { StepDef } from "../workflows/types.ts";
import { resolveMultipartInput } from "./multipart-input.ts";
import { maybeOffload, previewOf } from "./offload.ts";
import { applySelector } from "./selectors.ts";
import { finalizeStepRow } from "./state.ts";
import { planStateWrite, stateValueKind } from "./state-write-plan.ts";
import { runBranchStep } from "./steps/branch.ts";
import { runModelStep } from "./steps/model.ts";
import { runParallelStep } from "./steps/parallel.ts";
import { runRequestStep } from "./steps/request.ts";
import { runTransformStep } from "./steps/transform.ts";
import { runWaitStep } from "./steps/wait.ts";
import { runWaitForEventStep } from "./steps/wait-for-event.ts";
import type { StepResult, StepRunContext } from "./types.ts";

export interface RunStepOutcome {
  result: StepResult;
  scope_value: unknown;
  raw_output?: unknown;
  result_storage_uri?: string | null;
  result_preview?: string | null;
  result_size_bytes?: number;
  result_sha256?: string;
}

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
  const out: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const key of secretKeys) {
    if (key in out) out[key] = "***REDACTED:secret_output***";
  }
  return out;
}

export async function runStep(
  ctx: StepRunContext,
  scope: Record<string, unknown>,
  workflowInput: unknown,
  callRunner: (sub: {
    ctx: StepRunContext;
    step: StepDef;
    scope: Record<string, unknown>;
    workflowInput: unknown;
  }) => Promise<StepResult>,
): Promise<RunStepOutcome> {
  const step = ctx.step;
  let result: StepResult;

  if (step.kind === "request" && step.state_read) {
    const sr = step.state_read;
    try {
      const row = await readWorkflowState(ctx.db, ctx.tenant_id, ctx.workflow_id, sr.key);
      const bound = row !== undefined ? row.value : (sr.default_value ?? null);
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
      const scope_value = undefined;
      const scrubbedScope = applyDeclaredSecrets(step, scope_value);
      const offload = await maybeOffload(ctx.db, {
        tenant_id: ctx.tenant_id,
        execution_id: ctx.execution_id,
        execution_privacy: ctx.execution_privacy,
        step_id: ctx.step_row_id,
        result: scrubbedScope ?? null,
      });
      await finalizeStepRow(ctx.db, ctx.step_row_id, result.status, result, {
        tenant_id: ctx.tenant_id,
        output_preview: offload.storage_uri ? null : (scrubbedScope ?? null),
        result_preview: offload.preview ?? previewOf(scrubbedScope ?? null),
        result_storage_uri: offload.storage_uri,
        result_sha256: offload.sha256,
      });
      log.execution.step.failed({
        step_id: step.id,
        kind: step.kind,
        duration_ms: result.duration_ms,
        error_code: result.error?.code,
        error_msg: result.error?.message,
        execution_id: ctx.execution_id,
      });
      return {
        result,
        scope_value,
        result_storage_uri: offload.storage_uri,
        result_preview: offload.preview,
        result_size_bytes: offload.size_bytes,
        result_sha256: offload.sha256,
      };
    }
  }

  const spooledTmpfiles: string[] = [];

  switch (step.kind) {
    case "request": {
      const fileCache = new Map<string, ResolvedFile>();
      const resolverCtx = { db: ctx.db, tenant_id: ctx.tenant_id, resolve_references: true };
      let resolvedMultipart:
        | import("./steps/request/dispatch.ts").ResolvedMultipartPart[]
        | undefined;
      let resolvedBodyFile: ResolvedFile | undefined;

      if (step.multipart && step.multipart.length > 0) {
        resolvedMultipart = [];
        for (const rawPart of step.multipart) {
          const part = await resolveMultipartInput(rawPart, {
            db: ctx.db,
            tenant_id: ctx.tenant_id,
            environment: ctx.execution_mode,
            input: workflowInput,
            scope,
            ...(ctx.principal ? { principal: ctx.principal } : {}),
          });
          if (part.file !== undefined) {
            const resolved = await walkAndResolve(part.file, resolverCtx, fileCache);
            const rf = resolved as unknown as ResolvedFile;
            let effectiveRf = rf;
            if (rf.size_bytes > SPOOL_THRESHOLD_BYTES) {
              const tmpPath = join(tmpdir(), `subkit-spool-${rf.id}-${Date.now()}`);
              const stream = await rf.openRead();
              const chunks: Uint8Array[] = [];
              for await (const chunk of stream) chunks.push(chunk);
              await Bun.write(tmpPath, new Blob(chunks as BlobPart[]));
              spooledTmpfiles.push(tmpPath);
              effectiveRf = {
                ...rf,
                openRead: async () => {
                  const { createReadStream } = await import("node:fs");
                  const nodeStream = createReadStream(tmpPath);
                  async function* gen(): AsyncIterable<Uint8Array> {
                    for await (const chunk of nodeStream) yield chunk as Uint8Array;
                  }
                  return gen();
                },
              };
            }
            type RMP = import("./steps/request/dispatch.ts").ResolvedMultipartPart;
            const entry: RMP = { name: part.name, file: effectiveRf };
            if (part.value !== undefined) entry.value = part.value;
            if (part.filename !== undefined) entry.filename = part.filename;
            if (part.content_type !== undefined) entry.content_type = part.content_type;
            resolvedMultipart.push(entry);
          } else {
            type RMP = import("./steps/request/dispatch.ts").ResolvedMultipartPart;
            const entry: RMP = { name: part.name };
            if (part.value !== undefined) entry.value = part.value;
            if (part.filename !== undefined) entry.filename = part.filename;
            if (part.content_type !== undefined) entry.content_type = part.content_type;
            resolvedMultipart.push(entry);
          }
        }
      }

      if (
        step.body !== null &&
        step.body !== undefined &&
        typeof step.body === "object" &&
        "$file" in (step.body as object)
      ) {
        const resolved = await walkAndResolve(step.body, resolverCtx, fileCache);
        resolvedBodyFile = resolved as unknown as ResolvedFile;
      }

      result = await runRequestStep({
        ctx,
        step,
        scope,
        ...(resolvedMultipart !== undefined ? { resolved_multipart: resolvedMultipart } : {}),
        ...(resolvedBodyFile !== undefined ? { resolved_body_file: resolvedBodyFile } : {}),
      });
      break;
    }
    case "transform":
      result = await runTransformStep({
        ctx,
        step,
        scope,
        input: workflowInput,
      });
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
    case "model":
      result = await runModelStep({ ctx, step, scope });
      break;
    case "call":
      result =
        (await supersededCall(ctx)) ?? (await callRunner({ ctx, step, scope, workflowInput }));
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

  if (result.status === "succeeded" && step.kind === "request" && step.state_write) {
    const sw = step.state_write;
    const plan = planStateWrite(result.output, sw.value_path);
    try {
      if (plan.write) {
        await writeWorkflowState(ctx.db, {
          tenant_id: ctx.tenant_id,
          workflow_id: ctx.workflow_id,
          key: sw.key,
          value: plan.value,
        });
      }
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
            value_kind: stateValueKind(plan),
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

  const scrubbedScope = applyDeclaredSecrets(step, scope_value);

  const offload = await maybeOffload(ctx.db, {
    tenant_id: ctx.tenant_id,
    execution_id: ctx.execution_id,
    execution_privacy: ctx.execution_privacy,
    step_id: ctx.step_row_id,
    result: scrubbedScope ?? result.output ?? null,
  });

  const warnings = result.warnings && result.warnings.length > 0 ? result.warnings : null;
  const output_preview = offload.storage_uri
    ? null
    : warnings
      ? { value: scrubbedScope ?? null, warnings }
      : (scrubbedScope ?? null);
  await finalizeStepRow(ctx.db, ctx.step_row_id, result.status, result, {
    tenant_id: ctx.tenant_id,
    output_preview,
    result_preview: offload.preview ?? previewOf(scrubbedScope ?? null),
    result_storage_uri: offload.storage_uri,
    result_sha256: offload.sha256,
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

  if (spooledTmpfiles.length > 0) {
    for (const tmpPath of spooledTmpfiles) {
      unlink(tmpPath).catch(() => {});
    }
  }

  return {
    result,
    scope_value,
    ...(raw_output !== undefined ? { raw_output } : {}),
    result_storage_uri: offload.storage_uri,
    result_preview: offload.preview,
    result_size_bytes: offload.size_bytes,
    result_sha256: offload.sha256,
  };
}

async function supersededCall(ctx: StepRunContext): Promise<StepResult | null> {
  try {
    await ctx.before_write_dispatch?.(undefined);
    return null;
  } catch (err) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: 0,
      error: {
        code: (err as { code?: string }).code ?? "execution_superseded",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
