import { and, eq, like, not } from "drizzle-orm";
import { resolveActor } from "../../../audit/recorders/types.ts";
import { conversationToolCalls } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { appendSnapshot, loadDraft } from "../../draft.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import type { ToolContext, ToolResult } from "../../tools/index.ts";
import { injectSyntheticToolCall, type SyntheticToolResult } from "./synthetic.ts";
import type { AutoPersistDispatch, AutoPersistInput } from "./types.ts";

export function autoPersistActor(p: AutoPersistInput) {
  return resolveActor({
    tenant_id: p.tenant_id,
    actor_id: p.principal?.id ?? p.actor_id,
    actor_type: p.principal?.kind ?? (p.actor_id === null ? "system" : "unknown"),
  });
}

export async function recordGatedCallOutcome(
  p: AutoPersistInput,
  outcome: "ok" | "error",
): Promise<void> {
  const gatedCallId = p.elicitation.tool_call_id;
  if (!gatedCallId) return;
  await p.db
    .update(conversationToolCalls)
    .set({ outcome })
    .where(
      and(
        eq(conversationToolCalls.tenant_id, p.tenant_id),
        eq(conversationToolCalls.id, gatedCallId),
        not(like(conversationToolCalls.tool, "ask\\_user\\_%")),
      ),
    );
}

export async function injectAndDispatch(
  p: AutoPersistInput,
  synthetic: SyntheticToolResult,
  decision: "confirmed" | "declined",
  from: { intent: CommitIntent } | { description: string },
): Promise<AutoPersistDispatch> {
  const callId = await injectSyntheticToolCall({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    synthetic,
    ...from,
    decision,
  });
  return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
}

export async function buildCommitContext(p: AutoPersistInput): Promise<ToolContext> {
  const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  let liveDraft = draft;
  return {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    ...(p.principal ? { principal: p.principal } : {}),
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: autoPersistActor(p).actor_id,
      actor_type: autoPersistActor(p).actor_type,
      db: p.db,
    }),
    getDraft: () => liveDraft,
    setDraft: async (next) => {
      liveDraft = next;
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
  };
}

export function invalidIntent(message: string): ToolResult {
  return { ok: false, error_code: "invalid_commit_intent", message, data: {} };
}

export function principalRequired(message: string, data: Record<string, unknown>): ToolResult {
  return { ok: false, error_code: "principal_required", message, data };
}

export function permissionDenied(message: string, workflowId: string): ToolResult {
  return { ok: false, error_code: "permission_denied", message, data: { workflow_id: workflowId } };
}
