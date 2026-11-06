import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, ne } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { maybeAutoPersistFromElicitation } from "../../conversations/persistence/auto-persist/index.ts";
import {
  appendMessage,
  insertToolCall,
  updateToolCallOutput,
} from "../../conversations/persistence/index.ts";
import { getConversation } from "../../conversations/service/get.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let principal: ResolvedPrincipal;

beforeAll(async () => {
  srv = await createHttpTestServer("approved-call-outcome");
  principal = {
    provider: "api_key",
    kind: "user",
    id: srv.userId,
    tenant_id: srv.tenantId,
    roles: ["admin"],
  };
});

afterAll(async () => {
  await srv.cleanup();
});

async function parkedCall(): Promise<{
  conversation_id: string;
  gated_call_id: string;
  elicitation: { id: string; tool_name: string; input: unknown; tool_call_id: string };
}> {
  const [conversation] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("seed conversation failed");
  const parent = await appendMessage(srv.db, srv.tenantId, conversation.id, "assistant", {
    text: "calling the connector",
  });
  const gated_call_id = await insertToolCall(srv.db, {
    tenant_id: srv.tenantId,
    conversation_id: conversation.id,
    parent_message_id: parent,
    tool: "call_connector",
    input: { connector_id: "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b", method: "POST" },
    approval_required: true,
  });
  await updateToolCallOutput(srv.db, gated_call_id, { pending: true }, "pending");
  const input = {
    kind: "external_write",
    question: "Orders: POST /orders — approve this call?",
    commit_intent: {
      kind: "execute_confirmed_tool_call",
      description: "Run call_connector",
      payload: { tool: "call_connector", approval_id: "8d3e5f1a-2b4c-4d6e-8f0a-1b2c3d4e5f60" },
    },
  };
  const [elicitation] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      tool_call_id: gated_call_id,
      tool_name: "ask_user_confirm",
      summary: "Orders: POST /orders",
      input,
      status: "resolved",
      output: { confirmed: true },
    })
    .returning({ id: conversationElicitations.id });
  if (!elicitation) throw new Error("seed elicitation failed");
  return {
    conversation_id: conversation.id,
    gated_call_id,
    elicitation: {
      id: elicitation.id,
      tool_name: "ask_user_confirm",
      input,
      tool_call_id: gated_call_id,
    },
  };
}

describe("an approved call that fails", () => {
  test("records its real outcome and keeps the person's approval on the follow-up row", async () => {
    const parked = await parkedCall();
    const dispatched = await maybeAutoPersistFromElicitation({
      tenant_id: srv.tenantId,
      conversation_id: parked.conversation_id,
      actor_id: srv.userId,
      principal,
      answer_actor: { kind: "human", user_id: srv.userId, via: "chat" },
      elicitation_output: { confirmed: true },
      elicitation: parked.elicitation,
      surface: "web",
      db: srv.db,
    });
    expect(dispatched.dispatched).toBe(true);
    expect(dispatched.synthetic_result?.ok).toBe(false);

    const [gated] = await srv.db
      .select({ outcome: conversationToolCalls.outcome })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, parked.gated_call_id));
    expect(gated?.outcome).toBe("error");

    const [followUp] = await srv.db
      .select({
        confirmation_state: conversationToolCalls.confirmation_state,
        outcome: conversationToolCalls.outcome,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.conversation_id, parked.conversation_id),
          ne(conversationToolCalls.id, parked.gated_call_id),
        ),
      );
    expect(followUp).toEqual({ confirmation_state: "confirmed", outcome: "error" });

    const detail = await getConversation(srv.tenantId, parked.conversation_id, srv.db);
    const shown = detail?.tool_calls.find((call) => call.id === parked.gated_call_id);
    expect(shown?.outcome).toBe("error");
  });

  test("an approved call that has not reported back claims no outcome", async () => {
    const parked = await parkedCall();
    const detail = await getConversation(srv.tenantId, parked.conversation_id, srv.db);
    const shown = detail?.tool_calls.find((call) => call.id === parked.gated_call_id);
    expect(shown?.outcome).toBeNull();
  });

  test("a declined call is still declined", async () => {
    const parked = await parkedCall();
    await srv.db
      .update(conversationElicitations)
      .set({ output: { confirmed: false } })
      .where(eq(conversationElicitations.id, parked.elicitation.id));
    await maybeAutoPersistFromElicitation({
      tenant_id: srv.tenantId,
      conversation_id: parked.conversation_id,
      actor_id: srv.userId,
      principal,
      answer_actor: { kind: "human", user_id: srv.userId, via: "chat" },
      elicitation_output: { confirmed: false },
      elicitation: parked.elicitation,
      surface: "web",
      db: srv.db,
    });
    const [followUp] = await srv.db
      .select({ confirmation_state: conversationToolCalls.confirmation_state })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.conversation_id, parked.conversation_id),
          ne(conversationToolCalls.id, parked.gated_call_id),
        ),
      );
    expect(followUp?.confirmation_state).toBe("declined");
    const detail = await getConversation(srv.tenantId, parked.conversation_id, srv.db);
    const shown = detail?.tool_calls.find((call) => call.id === parked.gated_call_id);
    expect(shown?.outcome).toBe("denied");
  });
});
