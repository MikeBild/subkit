import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { recordTransition } from "../../conversations/confirmation.ts";
import {
  appendMessage,
  insertToolCall,
  updateToolCallOutput,
} from "../../conversations/persist.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id: string;
let assistant_message_id: string;
let ok_call_id: string;
let denied_call_id: string;
let declined_call_id: string;
let legacy_call_id: string;

interface ToolCallProjection {
  id: string;
  tool: string;
  output: unknown;
  confirmation_state: string | null;
  approved_at: string | null;
  outcome: string | null;
}

interface DetailBody {
  tool_calls: ToolCallProjection[];
  messages: Array<{
    id: string;
    parts: Array<{ type: string; call_id?: string; outcome?: string | null }>;
  }>;
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-tool-call-outcome");
  const [c] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  conversation_id = c!.id;
  assistant_message_id = await appendMessage(srv.db, srv.tenantId, conversation_id, "assistant", {
    text: "calling tools",
  });

  const base = {
    tenant_id: srv.tenantId,
    conversation_id,
    parent_message_id: assistant_message_id,
    approval_required: false,
  };

  ok_call_id = await insertToolCall(srv.db, { ...base, tool: "list_workflows", input: {} });
  await updateToolCallOutput(srv.db, ok_call_id, { workflows: [] }, "ok");

  denied_call_id = await insertToolCall(srv.db, { ...base, tool: "run_workflow", input: {} });
  await updateToolCallOutput(srv.db, denied_call_id, { rows: [] }, "denied");

  declined_call_id = await insertToolCall(srv.db, {
    ...base,
    tool: "save_workflow_draft",
    input: {},
    approval_required: true,
  });
  await updateToolCallOutput(
    srv.db,
    declined_call_id,
    { status: "awaiting_confirmation" },
    "pending",
  );
  await recordTransition(srv.db, {
    tool_call_id: declined_call_id,
    tenant_id: srv.tenantId,
    to_state: "declined",
    tool: "save_workflow_draft",
  });

  const [legacy] = await srv.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: srv.tenantId,
      conversation_id,
      parent_message_id: assistant_message_id,
      tool: "inspect_workflow",
      input: {},
      output: { rows: [] },
      approval_required: false,
    })
    .returning({ id: conversationToolCalls.id });
  legacy_call_id = legacy!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

async function detail(): Promise<DetailBody> {
  const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversation_id}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as DetailBody;
}

function byId(body: DetailBody, id: string): ToolCallProjection {
  const found = body.tool_calls.find((tc) => tc.id === id);
  expect(found).toBeDefined();
  return found as ToolCallProjection;
}

describe("GET /v1/conversations/:id · tool_calls", () => {
  test("emits confirmation_state, approved_at and outcome", async () => {
    const body = await detail();
    const ok = byId(body, ok_call_id);
    expect(ok.outcome).toBe("ok");
    expect(ok.confirmation_state).toBeNull();
    expect(ok.approved_at).toBeNull();
  });

  test("a failure whose output mimics a success still reports its outcome", async () => {
    const body = await detail();
    const denied = byId(body, denied_call_id);
    expect(denied.output).toEqual(byId(body, legacy_call_id).output);
    expect(denied.outcome).toBe("denied");
  });

  test("a declined confirmation reports confirmation_state: declined", async () => {
    const body = await detail();
    const declined = byId(body, declined_call_id);
    expect(declined.confirmation_state).toBe("declined");
    expect(declined.outcome).toBe("pending");
  });

  test("a legacy row with a NULL outcome serialises as null", async () => {
    const body = await detail();
    expect(byId(body, legacy_call_id).outcome).toBeNull();
  });
});

describe("GET /v1/conversations/:id · messages", () => {
  test("the tool_result part carries the same outcome as the flat tool_calls entry", async () => {
    const body = await detail();
    const assistant = body.messages.find((m) => m.id === assistant_message_id);
    expect(assistant).toBeDefined();
    const results = (assistant?.parts ?? []).filter((p) => p.type === "tool_result");
    expect(results.length).toBe(body.tool_calls.length);
    for (const part of results) {
      expect(part.outcome).toBe(byId(body, part.call_id as string).outcome);
    }
    expect(new Set(results.map((p) => p.outcome))).toEqual(
      new Set(["ok", "denied", "pending", null]),
    );
  });
});
