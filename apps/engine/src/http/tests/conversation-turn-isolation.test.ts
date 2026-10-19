import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acquireConversationTurn, releaseConversationTurn } from "../../conversations/turns.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  knowledgeSources,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
beforeAll(async () => {
  srv = await createHttpTestServer("conversation_turn_isolation");
});
afterAll(async () => {
  await srv?.cleanup();
});

test("HTTP refuses another client's turn before persisting its message or resolving a question", async () => {
  const [conversation] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, owner_id: srv.userId, status: "active" })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  const [elicitation] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      tool_name: "ask_user_text",
      summary: "Choose a destination",
      input: { question: "Choose a destination" },
      status: "pending",
    })
    .returning();
  if (!elicitation) throw new Error("missing elicitation");
  const ctrl = await acquireConversationTurn(srv.tenantId, conversation.id, srv.db);
  const headers = { Authorization: `Bearer ${srv.apiKey}`, "Content-Type": "application/json" };
  try {
    for (const accept of ["application/json", "text/event-stream"]) {
      const response = await fetch(`${srv.baseUrl}/v1/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { ...headers, Accept: accept },
        body: JSON.stringify({ message: "must not be stored" }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("conversation_turn_in_progress");
    }
    const response = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation.id}/elicitations/${elicitation.id}/respond`,
      { method: "POST", headers, body: JSON.stringify({ output: { text: "must not resolve" } }) },
    );
    expect(response.status).toBe(409);
    const upload = new FormData();
    upload.set("message", "must not ingest");
    upload.append(
      "files",
      new File(["rejected attachment"], "rejected.txt", { type: "text/plain" }),
    );
    const uploadResponse = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation.id}/messages/upload`,
      {
        method: "POST",
        headers: { Authorization: headers.Authorization },
        body: upload,
      },
    );
    expect(uploadResponse.status).toBe(409);
    const sources = await srv.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, srv.tenantId));
    expect(sources).toHaveLength(0);
    const compactResponse = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation.id}/compact`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ keep_last: 0 }),
      },
    );
    expect(compactResponse.status).toBe(409);
    const messages = await srv.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, srv.tenantId),
          eq(conversationMessages.conversation_id, conversation.id),
        ),
      );
    expect(messages).toHaveLength(0);
    const [pending] = await srv.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, srv.tenantId),
          eq(conversationElicitations.id, elicitation.id),
        ),
      );
    expect(pending?.status).toBe("pending");
    expect(pending?.output).toBeNull();
  } finally {
    await releaseConversationTurn(srv.tenantId, conversation.id, ctrl);
  }
});

test("an elicitation from another conversation is rejected without resolving or replaying it", async () => {
  const rows = await srv.db
    .insert(conversations)
    .values([
      { tenant_id: srv.tenantId, owner_id: srv.userId, status: "active" },
      { tenant_id: srv.tenantId, owner_id: srv.userId, status: "awaiting_input" },
    ])
    .returning();
  const [first, second] = rows;
  if (!first || !second) throw new Error("missing conversations");
  const [question] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: second.id,
      tool_name: "ask_user_text",
      summary: "Choose a destination",
      input: { question: "Choose a destination" },
      status: "pending",
    })
    .returning();
  if (!question) throw new Error("missing question");
  const response = await fetch(
    `${srv.baseUrl}/v1/conversations/${first.id}/elicitations/${question.id}/respond`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${srv.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ output: { text: "must not cross dialogs" } }),
    },
  );
  expect(response.status).toBe(404);
  const [unchanged] = await srv.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, srv.tenantId),
        eq(conversationElicitations.id, question.id),
      ),
    );
  expect(unchanged?.status).toBe("pending");
  const messages = await srv.db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, srv.tenantId),
        eq(conversationMessages.conversation_id, first.id),
      ),
    );
  expect(messages).toHaveLength(0);
});
