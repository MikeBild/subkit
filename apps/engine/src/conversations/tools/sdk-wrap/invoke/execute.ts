import { admittedCoveringAuthority } from "../../../../execution/core/run-coverage.ts";
import { withContext } from "../../../../logging/context.ts";
import { errorFields, log, logger } from "../../../../logging/index.ts";
import { startToolSpan } from "../../../../observability/langfuse-spans.ts";
import {
  boundForPersistence,
  type TruncatedOutput,
  truncateForLlm,
  withTruncationMarkers,
} from "../../../../tools/truncate.ts";
import {
  FileNotFoundError,
  type ResolvedFile,
  resolveAttachmentSlugsInArgs,
  walkAndResolve,
} from "../../../attachments.ts";
import { recordConfirmationSkipped, recordTransition } from "../../../confirmation.ts";
import { createDraftSnapshot } from "../../../draft-checkpoints.ts";
import { updateToolCallOutput } from "../../../persistence/index.ts";
import { describeToolExecutionFailure } from "../../../tool-execution-failure.ts";
import { hideCapabilityLinks } from "../../capability-link.ts";
import type { ToolResult } from "../../index.ts";
import { checkToolPermission, type ToolPermissionResult } from "../../permission-gate.ts";
import { normalizeToolResultPayload, toolCallOutcome } from "../../result-payload.ts";
import { permissionRefusal } from "../pregate.ts";
import type { WrappedToolOutput } from "../state.ts";
import {
  type InvokeCall,
  type InvokeEnv,
  persistToolResult,
  pushToolResult,
  recordCall,
} from "./env.ts";
import type { GatePassed } from "./gate.ts";
import { autoloadForCall, autoloadForResultDiagnoses } from "./skills.ts";

export interface Executed {
  result: ToolResult;
  resultPayload: unknown;
  modelVisibleOutput: unknown;
}

export type ExecuteOutcome = { done: WrappedToolOutput } | { executed: Executed };

async function resolveArgs(
  env: InvokeEnv,
  call: InvokeCall,
  passed: GatePassed,
): Promise<{ done: WrappedToolOutput } | { resolvedArgs: Record<string, unknown> }> {
  const { ctx, db } = env;
  const resolveCache = new Map<string, ResolvedFile>();
  try {
    const pinnedArgs = await resolveAttachmentSlugsInArgs(call.rawArgs, {
      db,
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      principal: passed.principal,
    });
    const resolvedArgs = await walkAndResolve(
      pinnedArgs,
      { db, tenant_id: ctx.tenant_id },
      resolveCache,
    );
    return { resolvedArgs };
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      const output: Record<string, unknown> = {
        ok: false,
        persistence: "none",
        error: {
          code: "file_not_found",
          message: err.message,
        },
      };
      await persistToolResult(env, call, output, "error");
      env.release();
      return { done: { ok: false, data: output } };
    }
    throw err;
  }
}

async function failExecution(
  env: InvokeEnv,
  call: InvokeCall,
  err: unknown,
  langfuseSpan: Awaited<ReturnType<typeof startToolSpan>>,
): Promise<WrappedToolOutput> {
  const { inner, ctx, db } = env;
  const failure = describeToolExecutionFailure(err);
  await langfuseSpan.finish({ status: "error", error: failure.span_error });
  const msg = failure.message;
  const output: Record<string, unknown> = failure.output;
  await persistToolResult(env, call, output, "error");
  if (inner.category === "tenant_write") {
    await recordTransition(db, {
      tool_call_id: call.toolCallId,
      tenant_id: ctx.tenant_id,
      to_state: "declined",
      actor_id: ctx.actor_id,
      tool: inner.name,
      data: { reason: msg, stage: "execute_threw" },
    });
  }
  recordCall(env, call, "error");
  log.conversation.tool.failed({
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    ...errorFields(err),
    duration_ms: Date.now() - call.startedAt,
  });
  return { ok: false, data: output };
}

async function snapshotDraft(env: InvokeEnv, call: InvokeCall): Promise<void> {
  const { inner, ctx, db } = env;
  try {
    const draftAfter = ctx.getDraft();
    await createDraftSnapshot(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        turn_index: call.step,
        draft: draftAfter,
        label: inner.name,
      },
      db,
    );
  } catch (err) {
    logger.warn({
      module: "conversations.draft_snapshot",
      action: "draft_snapshot.failed",
      conversation_id: ctx.conversation_id,
      tool: inner.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function executeTool(
  env: InvokeEnv,
  call: InvokeCall,
  passed: GatePassed,
): Promise<ExecuteOutcome> {
  const { inner, ctx, events, db } = env;
  const { rawArgs, perCallCtx, toolCallId } = call;
  const resolved = await resolveArgs(env, call, passed);
  if ("done" in resolved) return resolved;
  const { resolvedArgs } = resolved;

  await autoloadForCall(env, rawArgs);

  const langfuseSpan = await startToolSpan({
    name: inner.name,
    input: resolvedArgs,
    metadata: {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: inner.name,
      category: inner.category,
      session_id: ctx.conversation_id,
    },
  });

  let result: ToolResult;
  const { pregateRefusal } = passed;
  const permCheck: ToolPermissionResult = pregateRefusal
    ? { allow: true }
    : inner.permission
      ? await checkToolPermission(perCallCtx, inner.permission, rawArgs)
      : { allow: true };
  try {
    result =
      pregateRefusal ??
      (permCheck.allow
        ? await withContext(
            { audit_execution_source: "tool-chain", conversation_id: ctx.conversation_id },
            () => inner.execute(perCallCtx, resolvedArgs),
          )
        : permissionRefusal(inner, permCheck));
  } catch (err) {
    return { done: await failExecution(env, call, err, langfuseSpan) };
  }
  if (inner.category === "tenant_write") {
    await recordTransition(db, {
      tool_call_id: toolCallId,
      tenant_id: ctx.tenant_id,
      to_state: result.ok ? "confirmed" : "declined",
      actor_id: ctx.actor_id,
      tool: inner.name,
      ...(result.ok ? {} : { data: { reason: "tool returned ok=false" } }),
    });
  }
  const { coverage } = passed;
  const admitted: {
    execution_authority_id?: unknown;
    hold_writes?: unknown;
    idempotent_replay?: unknown;
  } = result.data && typeof result.data === "object" ? result.data : {};
  if (
    coverage.covered &&
    admitted.idempotent_replay !== true &&
    admittedCoveringAuthority(passed.resolvedRule, coverage, admitted) !== null
  ) {
    await recordConfirmationSkipped({
      db,
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: toolCallId,
      tool: inner.name,
      environment: coverage.environment,
      covering_authority_id: coverage.authority_id,
      actor_id: ctx.actor_id ?? null,
      actor_type: passed.principal?.kind ?? (ctx.actor_id ? "unknown" : "system"),
    });
  }

  const resultPayload: unknown = normalizeToolResultPayload(result);
  const modelSafePayload = hideCapabilityLinks(resultPayload);
  await langfuseSpan.finish({
    output: modelSafePayload,
    status: result.ok ? "success" : "error",
  });
  const skipTruncate = inner.name === "get_raw_result";
  const truncated: TruncatedOutput = skipTruncate
    ? { truncated: false, data: modelSafePayload }
    : truncateForLlm(modelSafePayload);
  const modelVisibleOutput = truncated.truncated
    ? withTruncationMarkers(truncated)
    : modelSafePayload;
  await updateToolCallOutput(
    db,
    toolCallId,
    boundForPersistence(resultPayload, truncated.raw_ref),
    toolCallOutcome(result),
  );
  await autoloadForResultDiagnoses(db, ctx, inner.name, resultPayload);

  if (result.ok && inner.category === "draft_write" && inner.captures_draft_snapshot !== false) {
    await snapshotDraft(env, call);
  }

  pushToolResult(env, call, truncated.truncated ? modelVisibleOutput : resultPayload);
  const completedDurationMs = Date.now() - call.startedAt;
  events.push({
    type: "activity",
    phase: "idle",
    label: `last: ${inner.name} ${result.ok ? "ok" : "fail"} · ${completedDurationMs}ms`,
    last_completed: {
      tool_name: inner.name,
      ok: result.ok,
      duration_ms: completedDurationMs,
    },
  });
  return { executed: { result, resultPayload, modelVisibleOutput } };
}
