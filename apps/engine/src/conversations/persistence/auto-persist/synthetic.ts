import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { conversationToolCalls } from "../../../db/schema/index.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import { COMMIT_INTENT_KINDS, type CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import { interpretConfirmDecision } from "../../tools/ask-user/interpret-confirm.ts";
import type { ToolResult } from "../../tools/index.ts";

export interface SyntheticToolResult {
  tool: string;
  ok: boolean;
  data?: unknown;
  error_code?: string;
  message?: string;
  next_best_actions?: string[];
  source: "harness_auto_persist";
}

export function isCompletedWorkflowPreparation(kind: unknown, data: unknown): boolean {
  return (
    kind === "run_workflow" &&
    data !== null &&
    typeof data === "object" &&
    "preview" in data &&
    data.preview === true &&
    "writes_held" in data &&
    data.writes_held === true &&
    "status" in data &&
    data.status === "succeeded"
  );
}

export function extractCommitIntent(input: unknown): CommitIntent | null {
  if (!input || typeof input !== "object") return null;
  const ci = (input as { commit_intent?: unknown }).commit_intent;
  if (!ci || typeof ci !== "object") return null;
  const obj = ci as Record<string, unknown>;
  if (typeof obj.kind !== "string") return null;
  if (!COMMIT_INTENT_KINDS.includes(obj.kind as CommitIntent["kind"])) return null;
  if (typeof obj.description !== "string") return null;
  if (!obj.payload || typeof obj.payload !== "object") return null;
  return {
    kind: obj.kind as CommitIntent["kind"],
    payload: obj.payload as Record<string, unknown>,
    description: obj.description,
  };
}

export interface DeclineSignal {
  error_code: "user_declined" | "empty_submission";
  reason: string;
}

export function checkDecline(toolName: string, output: unknown): DeclineSignal | null {
  if (output === null || output === undefined) {
    return { error_code: "user_declined", reason: "operator_dismissed_elicitation" };
  }
  const out = (output ?? {}) as Record<string, unknown>;
  if (interpretConfirmDecision(out) === "declined") {
    return { error_code: "user_declined", reason: "operator_rejected_confirmation" };
  }
  if (toolName === "ask_user_confirm") {
    const decision = interpretConfirmDecision(out);
    if (decision === "declined") {
      return { error_code: "user_declined", reason: "operator_rejected_confirmation" };
    }
    if (decision !== "confirmed") {
      return { error_code: "user_declined", reason: "operator_did_not_confirm" };
    }
    return null;
  }
  if (toolName === "ask_user_form") {
    const values =
      typeof out.values === "object" && out.values !== null
        ? (out.values as Record<string, unknown>)
        : out;
    const hasContent = Object.values(values).some((v) => v !== null && v !== undefined && v !== "");
    if (!hasContent) {
      return { error_code: "empty_submission", reason: "operator_submitted_empty_form" };
    }
    return null;
  }
  return null;
}

export function intentToolName(intent: CommitIntent): string {
  switch (intent.kind) {
    case "save_connector_draft":
      return "save_connector_draft";
    case "save_workflow_draft":
      return "save_workflow_draft";
    case "delete_connector":
      return "delete_connector";
    case "delete_workflow":
      return "delete_workflow";
    case "rollback_after_execute":
      return "rollback_after_execute";
    case "oauth_completed":
      return "authenticate_oauth";
    case "credential_reissue_completed":
      return "request_connector_reauth";
    case "run_workflow":
      return "run_workflow";
    case "create_api_key":
      return "create_api_key";
    case "apply_workflow_patch":
      return "edit_workflow_patch";
    case "update_workflow_metadata":
      return "update_workflow";
    case "commit_held_workflow_writes": {
      const tool = intent.payload.tool;
      return typeof tool === "string" && tool.length > 0 ? tool : "run_workflow";
    }
    case "execute_confirmed_tool_call": {
      const tool = intent.payload.tool;
      return typeof tool === "string" && tool.length > 0 ? tool : "unknown_tool";
    }
    case "grant_relayed_tool_call": {
      const tool = intent.payload.tool;
      return typeof tool === "string" && tool.length > 0 ? tool : "unknown_tool";
    }
  }
}

export function buildDeclineSynthetic(
  intent: CommitIntent,
  signal: DeclineSignal,
): SyntheticToolResult {
  return {
    tool: intentToolName(intent),
    ok: false,
    error_code: signal.error_code,
    message:
      signal.error_code === "user_declined"
        ? `The operator declined this ${intent.kind}. It is settled — do NOT re-propose the same action or re-issue the same confirmation. Nothing was performed. Stop and wait for a new instruction from the user; only revisit this if they ask you to.`
        : "operator submitted an empty form — re-ask only if you have a different question to pose",
    next_best_actions: ["ask_user", "cannot_help"],
    source: "harness_auto_persist",
  };
}

export function buildSyntheticFromResult(
  toolName: string,
  result: ToolResult,
): SyntheticToolResult {
  if (result.ok) {
    return {
      tool: toolName,
      ok: true,
      data: result.data,
      source: "harness_auto_persist",
    };
  }
  return {
    tool: toolName,
    ok: false,
    ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.next_best_actions !== undefined
      ? { next_best_actions: result.next_best_actions }
      : {}),
    source: "harness_auto_persist",
  };
}

export async function injectSyntheticToolCall(p: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  synthetic: SyntheticToolResult;
  intent?: CommitIntent;
  description?: string;
  decision: "confirmed" | "declined";
}): Promise<string> {
  const commitIntentKind = p.intent?.kind ?? null;
  const callId = await insertToolCall(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    tool: p.synthetic.tool,
    input: {
      _harness_auto_persist: true,
      commit_intent_kind: commitIntentKind,
      description: p.intent?.description ?? p.description ?? null,
    },
    approval_required: false,
  });
  const prepared = isCompletedWorkflowPreparation(commitIntentKind, p.synthetic.data);
  await updateToolCallOutput(
    p.db,
    callId,
    p.synthetic,
    p.synthetic.ok || prepared ? "ok" : "error",
  );
  await p.db
    .update(conversationToolCalls)
    .set({
      confirmation_state: commitIntentKind === "run_workflow" ? null : p.decision,
      confirmation_data: { source: "harness_auto_persist", commit_intent_kind: commitIntentKind },
    })
    .where(
      and(eq(conversationToolCalls.tenant_id, p.tenant_id), eq(conversationToolCalls.id, callId)),
    );
  await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", {
    tool: p.synthetic.tool,
    output: p.synthetic,
    _harness_auto_persist: true,
  });
  return callId;
}
