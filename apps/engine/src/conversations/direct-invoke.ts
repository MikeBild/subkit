// Direct conversation-tool invocation — the user-driven fast path.
//
// The authoring loop's tools are normally dispatched by the model, so
// every iteration costs an LLM round-trip even when the operator knows
// exactly which deterministic tool to run next: preview the draft,
// probe the connector draft, apply a hand-written patch, roll back a
// snapshot. This module runs ONE conversation tool directly against
// the conversation's draft — same tool implementation, same gates,
// same persistence, same draft snapshots — without a model turn.
//
// Context coherence is the load-bearing property: the persisted
// `conversation_tool_calls` row is the same row the loop writes, and
// the model-message replay (persist.ts `buildModelMessages`) renders
// every such row as an assistant `tool-call` + `tool-result` pair. A
// directly-invoked preview is therefore fully visible to the NEXT
// model turn — the model reads the real step shapes instead of being
// told about them second-hand.
//
// The allowlist is deliberately narrow: draft-scoped, deterministic,
// elicitation-free tools only. Tenant writes (save_workflow_draft,
// connector saves, run_workflow) stay behind the conversation loop's
// confirm gates — this path never weakens write safety. Previews keep
// their hold-writes contract: `execute_writes` defaults to false in
// the tool itself.

import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";
import { actorFields } from "../llm/accounting/actor.ts";
import { log, logger } from "../logging/logger.ts";
import { recordConversationToolCall } from "../observability/instrumentation.ts";
import { startToolSpan } from "../observability/langfuse-spans.ts";
import { appendSnapshot, loadDraft } from "./draft.ts";
import { createDraftSnapshot } from "./draft-checkpoints.ts";
import { listElicitationsForConversation } from "./elicitations.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "./persist.ts";
import { PendingElicitationBlockedError } from "./service/shared.ts";
import { computeLineDiff } from "./text-line-diff.ts";
import { getTool, type ToolContext, type ToolResult } from "./tools/index.ts";
import { checkToolPermission, type ToolPermissionResult } from "./tools/permission-gate.ts";
import { normalizeToolResultPayload, toolCallOutcome } from "./tools/result-payload.ts";
import type { DraftDocument } from "./types.ts";

/**
 * Tools invocable without a model turn. Draft-scoped and deterministic;
 * none of them elicit, none of them are `tenant_write`. Everything else
 * must go through the conversation loop where the confirm gates live.
 */
export const DIRECT_INVOKE_TOOLS: ReadonlySet<string> = new Set([
  "dry_run_workflow",
  "dry_run_step",
  "probe_connector_draft",
  "edit_workflow_patch",
  "validate_draft",
  "list_draft_snapshots",
  "restore_draft_snapshot",
]);

export class DirectInvokeError extends Error {
  readonly error_code: string;
  readonly status: 400 | 404 | 409;

  constructor(error_code: string, message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "DirectInvokeError";
    this.error_code = error_code;
    this.status = status;
  }
}

export interface DirectInvokeParams {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  tool: string;
  args: Record<string, unknown>;
}

export interface DirectInvokeOutcome {
  ok: boolean;
  tool: string;
  tool_call_id: string;
  /** Full (untruncated) tool payload — the caller is a client, not the model. */
  data: unknown;
  committed_workflow_id?: string;
  /** Live-progress lines the tool emitted while running. */
  logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; ts: string }>;
  /** Unified line-diff hunks for draft-mutating tools. */
  diffs: Array<{ title: string; language: "json" | "yaml" | "text"; hunks: unknown[] }>;
}

/**
 * Run one allowlisted conversation tool directly. Validates args
 * against the tool's own schema, enforces its declarative RBAC gate,
 * persists the same rows the loop would, and snapshots the draft after
 * a successful draft mutation.
 */
export async function invokeConversationToolDirect(
  p: DirectInvokeParams,
): Promise<DirectInvokeOutcome> {
  const tool = getTool(p.tool);
  if (!tool || !DIRECT_INVOKE_TOOLS.has(p.tool)) {
    throw new DirectInvokeError(
      "tool_not_direct_invocable",
      `tool ${p.tool} cannot be invoked directly — drive it through a conversation turn`,
      400,
    );
  }
  // Defense-in-depth alongside the allowlist: a tenant write must never
  // ride this path even if the allowlist regresses.
  if (tool.category === "tenant_write") {
    throw new DirectInvokeError(
      "tool_not_direct_invocable",
      `tool ${p.tool} mutates tenant state and requires the conversation loop's confirm gate`,
      400,
    );
  }

  const [convRow] = await p.db
    .select({ id: conversations.id, turn_count: conversations.turn_count })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  if (!convRow) {
    throw new DirectInvokeError("conversation_not_found", "conversation not found", 404);
  }

  // Same guard as appendUserMessage: while an ask_user_* is pending the
  // draft is mid-decision — resolve the dialog first.
  const pending = (await listElicitationsForConversation(p.tenant_id, p.conversation_id, p.db))
    .filter((elicitation) => elicitation.status === "pending")
    .at(0);
  if (pending) {
    throw new PendingElicitationBlockedError({
      id: pending.id,
      tool_name: pending.tool_name,
      summary: pending.summary,
      tool_call_id: pending.tool_call_id,
      input: pending.input,
    });
  }

  let args: Record<string, unknown>;
  try {
    args = tool.inputSchema.parse(p.args) as Record<string, unknown>;
  } catch (err) {
    throw new DirectInvokeError(
      "invalid_tool_args",
      err instanceof Error ? err.message : String(err),
      400,
    );
  }

  let draft: DraftDocument = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  const logs: DirectInvokeOutcome["logs"] = [];
  const diffs: DirectInvokeOutcome["diffs"] = [];

  // Anchor row + tool-call row — identical shape to the loop's wrapper,
  // so the replay assembler renders this call for the next model turn.
  const assistantMessageId = await appendMessage(
    p.db,
    p.tenant_id,
    p.conversation_id,
    "assistant",
    {},
  );
  const toolCallId = await insertToolCall(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    parent_message_id: assistantMessageId,
    tool: tool.name,
    input: args,
    approval_required: false,
  });
  log.conversation.tool.called({
    conversation_id: p.conversation_id,
    tool: tool.name,
    step: 0,
  });

  const { EngineClient } = await import("../engine-client/index.ts");
  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    principal: p.principal ?? null,
    tool_call_id: toolCallId,
    assistant_message_id: assistantMessageId,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: p.actor_id,
      actor_type: actorFields(p.principal).actor_type,
      db: p.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
    onLog: (level, message) => {
      logs.push({ level, message, ts: new Date().toISOString() });
    },
    emitDiff: ({ title, language, before, after }) => {
      try {
        const hunks = computeLineDiff(before, after, { context: 3 });
        if (hunks.length > 0) diffs.push({ title, language, hunks });
      } catch {
        // Best-effort — never block the tool on a diff failure.
      }
    },
  };

  const langfuseSpan = await startToolSpan({
    name: tool.name,
    input: args,
    metadata: {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      tool: tool.name,
      category: tool.category,
      session_id: p.conversation_id,
      dispatch: "direct",
    },
  });

  const startedAt = Date.now();
  const permCheck: ToolPermissionResult = tool.permission
    ? await checkToolPermission(ctx, tool.permission, args)
    : { allow: true };

  let result: ToolResult;
  try {
    result = permCheck.allow
      ? await tool.execute(ctx, args)
      : (tool.permission?.denyResult?.(permCheck.permission, permCheck.reason) ?? {
          ok: false,
          data: {
            error: "permission_denied",
            permission: permCheck.permission,
            reason: permCheck.reason,
          },
        });
  } catch (err) {
    await langfuseSpan.finish({ status: "error", error: err });
    const msg = err instanceof Error ? err.message : String(err);
    const output = { error: msg };
    await updateToolCallOutput(p.db, toolCallId, output, "error");
    recordConversationToolCall({
      category: tool.category,
      tool: tool.name,
      outcome: "error",
      duration_ms: Date.now() - startedAt,
    });
    log.conversation.tool.failed({
      conversation_id: p.conversation_id,
      tool: tool.name,
      error: msg,
      duration_ms: Date.now() - startedAt,
    });
    return { ok: false, tool: tool.name, tool_call_id: toolCallId, data: output, logs, diffs };
  }

  const resultPayload = normalizeToolResultPayload(result);
  await langfuseSpan.finish({
    output: resultPayload,
    status: result.ok ? "success" : "error",
  });
  await updateToolCallOutput(p.db, toolCallId, resultPayload, toolCallOutcome(result));

  // Draft snapshot after every successful draft mutation — same
  // rollback contract as the loop path.
  if (result.ok && tool.category === "draft_write") {
    try {
      await createDraftSnapshot(
        {
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          turn_index: convRow.turn_count ?? 0,
          draft: ctx.getDraft(),
          label: tool.name,
        },
        p.db,
      );
    } catch (err) {
      logger.warn({
        module: "conversations.draft_snapshot",
        action: "draft_snapshot.failed",
        conversation_id: p.conversation_id,
        tool: tool.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Tool-role audit message — keeps the turn trail self-contained in
  // conversation_messages, exactly like the loop path.
  await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", {
    tool: tool.name,
    output: resultPayload,
  });

  const durationMs = Date.now() - startedAt;
  recordConversationToolCall({
    category: tool.category,
    tool: tool.name,
    outcome: result.ok ? "ok" : "error",
    duration_ms: durationMs,
  });
  const logCtx = {
    conversation_id: p.conversation_id,
    tool: tool.name,
    ok: result.ok,
    paused: false,
    committed: Boolean(result.committed_workflow_id),
    duration_ms: durationMs,
  };
  if (result.ok) log.conversation.tool.succeeded(logCtx);
  else log.conversation.tool.failed(logCtx);

  return {
    ok: result.ok,
    tool: tool.name,
    tool_call_id: toolCallId,
    data: resultPayload,
    ...(typeof result.committed_workflow_id === "string"
      ? { committed_workflow_id: result.committed_workflow_id }
      : {}),
    logs,
    diffs,
  };
}
