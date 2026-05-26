// Synthetic-tool-result construction + commit-intent extraction +
// decline detection + the row insertion that injects the synthetic
// pair (`conversation_tool_calls` row + `tool` message) into the
// conversation timeline so the LLM's next turn sees a regular
// tool-result with `source: "harness_auto_persist"`.

import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { conversationToolCalls } from "../../../db/schema/index.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../../persist.ts";
import { COMMIT_INTENT_KINDS, type CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import type { ToolResult } from "../../tools/index.ts";

/**
 * Shape of the synthetic tool result the harness injects into the
 * conversation event log. The LLM's next turn sees this as a regular
 * tool-result message, with the distinguishing `source` field set to
 * `"harness_auto_persist"` so logs and tests can tell synthetic from
 * real LLM-issued tool calls.
 */
export interface SyntheticToolResult {
  tool: string;
  ok: boolean;
  data?: unknown;
  error_code?: string;
  message?: string;
  next_best_actions?: string[];
  source: "harness_auto_persist";
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
  if (toolName === "ask_user_confirm") {
    if (out.confirmed === false || out.declined === true) {
      return { error_code: "user_declined", reason: "operator_rejected_confirmation" };
    }
    if (out.confirmed !== true) {
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

export function intentToolName(kind: CommitIntent["kind"]): string {
  switch (kind) {
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
      // G8: the OAuth flow's commit_intent maps to the tool whose
      // result the dispatcher injects — authenticate_oauth.
      return "authenticate_oauth";
  }
}

export function buildDeclineSynthetic(
  intent: CommitIntent,
  signal: DeclineSignal,
): SyntheticToolResult {
  return {
    tool: intentToolName(intent.kind),
    ok: false,
    error_code: signal.error_code,
    message:
      signal.error_code === "user_declined"
        ? `operator declined the ${intent.kind} action — do not retry without asking again`
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

/**
 * Insert a synthetic `conversation_tool_calls` row + matching `tool`
 * message into the conversation timeline. The row carries `output =
 * synthetic` so `buildModelMessages` emits a `tool-call` +
 * `tool-result` pair on the next turn — the LLM sees it as a normal
 * tool result with `source: "harness_auto_persist"`.
 */
export async function injectSyntheticToolCall(p: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  synthetic: SyntheticToolResult;
  intent: CommitIntent;
}): Promise<string> {
  const callId = await insertToolCall(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    tool: p.synthetic.tool,
    input: {
      _harness_auto_persist: true,
      commit_intent_kind: p.intent.kind,
      description: p.intent.description,
    },
    approval_required: false,
  });
  await updateToolCallOutput(p.db, callId, p.synthetic);
  // Confirmation-state column carries `confirmed` so the read path
  // and observability dashboards can filter on harness-driven writes.
  await p.db
    .update(conversationToolCalls)
    .set({
      confirmation_state: p.synthetic.ok ? "confirmed" : "declined",
      confirmation_data: { source: "harness_auto_persist", commit_intent_kind: p.intent.kind },
    })
    .where(eq(conversationToolCalls.id, callId));
  await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", {
    tool: p.synthetic.tool,
    output: p.synthetic,
    _harness_auto_persist: true,
  });
  return callId;
}
