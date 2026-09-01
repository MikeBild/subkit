// Per-step orchestration: applies the configured data_selector to the
// raw step result, applies offload, persists the step row, and emits the
// debug log. Drivers (request, transform, ...) own the actual work and
// the retry loops; this file owns the surrounding ceremony.

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type ResolvedFile, SPOOL_THRESHOLD_BYTES, walkAndResolve } from "../files/resolver.ts";
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
import { runTransformStep } from "./steps/transform.ts";
import { runWaitStep } from "./steps/wait.ts";
import { runWaitForEventStep } from "./steps/wait-for-event.ts";
import type { StepResult, StepRunContext } from "./types.ts";

// Persistent workflow state — `state_read` binds a
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
  /**
   * Durable locator of this step's offloaded result, when the step's
   * payload exceeded `STEP_RESULT_DB_BYTES` and was spilled to S3.
   * `s3://<bucket>/<key>` for new writes (`fixture://<uuid>` is legacy);
   * `null` when the result was small enough to
   * persist inline. The loop runner reuses this locator to build an
   * `OffloadRef` without a second offload write.
   */
  result_storage_uri?: string | null;
  /**
   * Inline `STEP_RESULT_PREVIEW_BYTES`-capped preview of the offloaded
   * payload. Set together with `result_storage_uri`; the loop runner
   * carries it onto the `OffloadRef.preview`.
   */
  result_preview?: string | null;
  /** Serialized byte size of the step result (offloaded or inline). */
  result_size_bytes?: number;
  /** Application SHA-256 of the serialized result. */
  result_sha256?: string;
}

// Redact step output keys the recipe declared as
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
  // The scope travels with the sub-step so a call can interpolate
  // `${scope.…}` in its input, exactly like a request step does for its
  // path/headers/body. Without it a call step could only pass literals.
  callRunner: (sub: {
    ctx: StepRunContext;
    step: StepDef;
    scope: Record<string, unknown>;
    workflowInput: unknown;
  }) => Promise<StepResult>,
): Promise<RunStepOutcome> {
  const step = ctx.step;
  let result: StepResult;

  // state_read: bind a persistent value into substitution scope
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

  // Resolve $file references in request step inputs before dispatch.
  // The per-step cache ensures the same fid only hits the DB once.
  // Tmpfiles are tracked for cleanup after the step completes.
  const spooledTmpfiles: string[] = [];

  switch (step.kind) {
    case "request": {
      const fileCache = new Map<string, ResolvedFile>();
      const resolverCtx = { db: ctx.db, tenant_id: ctx.tenant_id };
      let resolvedMultipart:
        | import("./steps/request/dispatch.ts").ResolvedMultipartPart[]
        | undefined;
      let resolvedBodyFile: ResolvedFile | undefined;

      if (step.multipart && step.multipart.length > 0) {
        resolvedMultipart = [];
        for (const part of step.multipart) {
          if (part.file !== undefined) {
            const resolved = await walkAndResolve(part.file, resolverCtx, fileCache);
            // resolved is a ResolvedFile when the $file ref was valid
            const rf = resolved as unknown as ResolvedFile;
            let effectiveRf = rf;
            // Spool large files to tmpfile so drivers get a seekable stream.
            if (rf.size_bytes > SPOOL_THRESHOLD_BYTES) {
              const tmpPath = join(tmpdir(), `sk-spool-${rf.id}-${Date.now()}`);
              // Use the ResolvedFile's bound `openRead` rather than calling
              // the object store with `rf.id` directly. The row UUID is not
              // the storage key — keys are
              // `<tenant>/<yyyy>/<mm>/<dd>/<uuid>` per `buildObjectKey`,
              // and `resolvedFromRow` already wires `openRead` to call
              // `storageKey(row.storage_uri)`.
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
            // Build ResolvedMultipartPart avoiding undefined property spread
            // (exactOptionalPropertyTypes requires omitting undefined properties).
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
    case "loop":
      result = await runLoopStep({ ctx, step, scope });
      break;
    case "call":
      result = await callRunner({ ctx, step, scope, workflowInput });
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

  // state_write: persist a dot-path slice of the step result AFTER
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

  // Scrub declared-secret outputs BEFORE offload + preview
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

  // Clean up any tmpfiles that were spooled for large $file parts.
  // Best-effort: a failure here does not change the step result.
  if (spooledTmpfiles.length > 0) {
    for (const tmpPath of spooledTmpfiles) {
      unlink(tmpPath).catch(() => {
        // Tolerated — the OS will GC tmpfiles on reboot.
      });
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
