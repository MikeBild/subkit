import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import {
  apiKeys,
  auditLog,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  roles,
  systemAccounts,
} from "../../db/schema/index.ts";
import { generateKey } from "../../identity/api-key.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let botKey = "";
let botId = "";

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("elicitation-respond-bot");
  const [memberRole] = await srv.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "member")));
  if (!memberRole) throw new Error("member role not seeded");
  const [bot] = await srv.db
    .insert(systemAccounts)
    .values({ tenant_id: srv.tenantId, name: "respond-bot", role_id: memberRole.id })
    .returning({ id: systemAccounts.id });
  if (!bot) throw new Error("seed system account failed");
  botId = bot.id;
  const key = generateKey();
  botKey = key.plaintext;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: botId,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
});

afterAll(async () => {
  await srv.cleanup();
});

async function seedPendingQuestion(): Promise<{
  conversationId: string;
  elicitationId: string;
  toolCallId: string;
}> {
  const [conversation] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, owner_id: botId, status: "awaiting_input" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("seed conversation failed");
  await srv.db.insert(conversationMessages).values({
    tenant_id: srv.tenantId,
    conversation_id: conversation.id,
    role: "user",
    content: { text: "set up the storage connector" },
  });
  const [toolCall] = await srv.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      tool: "ask_user_text",
      input: { question: "Which region?" },
    })
    .returning({ id: conversationToolCalls.id });
  if (!toolCall) throw new Error("seed tool call failed");
  const [elicitation] = await srv.db
    .insert(conversationElicitations)
    .values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      tool_call_id: toolCall.id,
      tool_name: "ask_user_text",
      summary: "Which region?",
      input: { question: "Which region?" },
      status: "pending",
    })
    .returning({ id: conversationElicitations.id });
  if (!elicitation) throw new Error("seed elicitation failed");
  return {
    conversationId: conversation.id,
    elicitationId: elicitation.id,
    toolCallId: toolCall.id,
  };
}

for (const route of ["elicitations", "tool-calls"]) {
  for (const accept of ["application/json", "text/event-stream"]) {
    describe(`POST /v1/conversations/{id}/${route}/{id}/respond with ${accept}`, () => {
      test("the answer lands with decided_by_kind=system_account and a system_account audit actor", async () => {
        const { conversationId, elicitationId, toolCallId } = await seedPendingQuestion();

        const res = await fetch(
          `${srv.baseUrl}/v1/conversations/${conversationId}/${route}/${route === "elicitations" ? elicitationId : toolCallId}/respond`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${botKey}`,
              "Content-Type": "application/json",
              Accept: accept,
            },
            body: JSON.stringify({ output: { text: "eu-central" } }),
          },
        );
        expect(res.status).toBe(200);
        const responseBody = await res.text();
        expect(responseBody).not.toContain("event: error");

        const [row] = await srv.db
          .select({
            status: conversationElicitations.status,
            decided_by: conversationElicitations.decided_by,
            decided_by_kind: conversationElicitations.decided_by_kind,
          })
          .from(conversationElicitations)
          .where(
            and(
              eq(conversationElicitations.tenant_id, srv.tenantId),
              eq(conversationElicitations.id, elicitationId),
            ),
          );
        expect(row).toEqual({
          status: "resolved",
          decided_by: botId,
          decided_by_kind: "system_account",
        });

        const decisions = await srv.db
          .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, srv.tenantId),
              eq(auditLog.action, AuditAction.APPROVAL_APPROVED),
              eq(auditLog.resource_type, "conversation_elicitation"),
              eq(auditLog.resource_id, elicitationId),
            ),
          );
        expect(decisions).toEqual([{ actor_type: "system_account", actor_id: botId }]);
      });

      test("a human answering through the same route is still recorded as a user", async () => {
        const { conversationId, elicitationId, toolCallId } = await seedPendingQuestion();

        const res = await fetch(
          `${srv.baseUrl}/v1/conversations/${conversationId}/${route}/${route === "elicitations" ? elicitationId : toolCallId}/respond`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${srv.apiKey}`,
              "Content-Type": "application/json",
              Accept: accept,
            },
            body: JSON.stringify({ output: { text: "us-east" } }),
          },
        );
        expect(res.status).toBe(200);
        const responseBody = await res.text();
        expect(responseBody).not.toContain("event: error");

        const [row] = await srv.db
          .select({
            decided_by: conversationElicitations.decided_by,
            decided_by_kind: conversationElicitations.decided_by_kind,
          })
          .from(conversationElicitations)
          .where(
            and(
              eq(conversationElicitations.tenant_id, srv.tenantId),
              eq(conversationElicitations.id, elicitationId),
            ),
          );
        expect(row).toEqual({ decided_by: srv.userId, decided_by_kind: "user" });
      });
    });
  }
}
