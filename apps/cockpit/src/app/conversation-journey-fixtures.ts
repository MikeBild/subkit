import { expect } from "bun:test";
import { type Journey, NOW, TENANT, USER, WORKFLOW, workflow } from "./journey-fixtures";

export const CONVERSATION = "66666666-6666-4666-8666-666666666666";
export const TURN = "99999999-9999-4999-8999-999999999999";
export const LATER = "2099-01-01T00:00:00.000Z";

export function conversationRecord(title: string, status = "active") {
  return {
    id: CONVERSATION,
    tenant_id: TENANT,
    target_workflow_id: WORKFLOW,
    target_connector_id: null,
    status,
    owner_id: USER,
    model: null,
    title,
    created_at: NOW,
    updated_at: NOW,
    message_count: 2,
  };
}

export const workflowTarget = {
  kind: "workflow",
  name: workflow.name,
  slug: workflow.slug,
  id: WORKFLOW,
  environment: "prod",
};

export function textMessage(id: string, role: "user" | "assistant", text: string) {
  return { id, role, parts: [{ type: "text", text }], model: null, created_at: NOW };
}

export function confirmCall(id: string, question: string, intent: string, workflowSlug?: string) {
  return {
    id,
    conversation_id: CONVERSATION,
    tool: "ask_user_confirm",
    input: {
      question,
      ...(workflowSlug ? { workflow: workflowSlug } : {}),
      commit_intent: { kind: intent },
    },
    output: null,
    approval_required: true,
    created_at: NOW,
    confirmation_state: "pending",
    approved_at: null,
    outcome: null,
  };
}

export function pendingApproval(id: string, callId: string, summary: string) {
  return {
    id,
    tool_call_id: callId,
    tool_name: "ask_user_confirm",
    summary,
    expires_at: LATER,
  };
}

export function stream(frames: [string, unknown][]) {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
}

export function outcome(conversation: unknown, status = "completed") {
  return ["outcome", { turn_id: TURN, conversation, status }] as [string, unknown];
}

export async function follow(app: Journey, testId: string) {
  const href = app.find(testId)?.getAttribute("href") ?? "";
  expect(href.startsWith(`${app.base}/`)).toBe(true);
  await app.go(href.slice(app.base.length));
}
