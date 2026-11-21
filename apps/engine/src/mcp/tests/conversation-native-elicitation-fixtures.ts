import { afterAll, beforeAll, expect } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { and, desc, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import {
  auditLog,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationTurns,
  mcpTasks,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

export function parseEnvelope(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const item = r.content?.[0];
  return JSON.parse(item?.type === "text" ? (item.text ?? "{}") : "{}") as Record<string, unknown>;
}

export let suite: McpTestSuite;

export let client: Client;

export let requests = 0;

async function seedResumeContext(conversationId: string): Promise<void> {
  await suite.http.db.insert(conversationMessages).values({
    tenant_id: suite.http.tenantId,
    conversation_id: conversationId,
    role: "user",
    content: { text: "Continue after the requested input." },
  });
  getMockProvider().setConversePlan(conversationId, []);
}

export async function seedPendingPrompt(p: {
  tool_name?: string;
  summary: string;
  input: Record<string, unknown>;
}): Promise<{ conversationId: string; elicitationId: string; taskId: string }> {
  const [conversation] = await suite.http.db
    .insert(conversations)
    .values({
      tenant_id: suite.http.tenantId,
      owner_id: suite.http.userId,
      status: "awaiting_input",
    })
    .returning();
  if (!conversation) throw new Error("conversation seed failed");
  await seedResumeContext(conversation.id);
  const [elicitation] = await suite.http.db
    .insert(conversationElicitations)
    .values({
      tenant_id: suite.http.tenantId,
      conversation_id: conversation.id,
      tool_name: p.tool_name ?? "ask_user_choice",
      summary: p.summary,
      input: p.input,
    })
    .returning();
  if (!elicitation) throw new Error("elicitation seed failed");
  const [taskRow] = await suite.http.db
    .insert(mcpTasks)
    .values({
      tenant_id: suite.http.tenantId,
      conversation_id: conversation.id,
      turn_seq: 1,
      kind: "start",
      actor_id: suite.http.userId,
      actor_kind: "user",
      request_source: "mcp",
      result: { conversation_id: conversation.id, status: "awaiting_input", events: [] },
    })
    .returning();
  if (!taskRow) throw new Error("task seed failed");
  return { conversationId: conversation.id, elicitationId: elicitation.id, taskId: taskRow.id };
}

export async function readElicitationRow(elicitationId: string) {
  const [row] = await suite.http.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, suite.http.tenantId),
        eq(conversationElicitations.id, elicitationId),
      ),
    );
  return row;
}

export async function readConversationStatus(conversationId: string): Promise<string | undefined> {
  const [row] = await suite.http.db
    .select({ status: conversations.status })
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, suite.http.tenantId), eq(conversations.id, conversationId)),
    );
  return row?.status;
}

export async function listAuditRows(elicitationId: string, action: string) {
  return suite.http.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, suite.http.tenantId),
        eq(auditLog.resource_type, "conversation_elicitation"),
        eq(auditLog.resource_id, elicitationId),
        eq(auditLog.action, action),
      ),
    );
}

export async function waitForResumedTask(conversationId: string): Promise<void> {
  await waitFor(
    async () => {
      const [row] = await suite.http.db
        .select()
        .from(mcpTasks)
        .where(
          and(
            eq(mcpTasks.tenant_id, suite.http.tenantId),
            eq(mcpTasks.conversation_id, conversationId),
            eq(mcpTasks.kind, "respond_elicitation"),
          ),
        )
        .orderBy(desc(mcpTasks.turn_seq))
        .limit(1);
      if (!row) return null;
      if (row.failure_reason) {
        throw new Error(`resumed MCP task failed: ${row.failure_reason}`);
      }
      return row.result ? row : null;
    },
    { tries: 500, sleepMs: 10, label: "resumed MCP task completion" },
  );
}

export async function waitForElicitationDeliveryReady(conversationId: string): Promise<void> {
  await waitFor(
    async () => {
      const [turn] = await suite.http.db
        .select({ state: conversationTurns.state })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.tenant_id, suite.http.tenantId),
            eq(conversationTurns.conversation_id, conversationId),
          ),
        )
        .orderBy(desc(conversationTurns.created_at))
        .limit(1);
      return turn?.state === "completed" ? turn : null;
    },
    { tries: 500, sleepMs: 10, label: "native elicitation delivery readiness" },
  );
}

export function setupNativeElicitationSuite(): void {
  requests = 0;
  beforeAll(async () => {
    testEnv.LLM_PROVIDER = "mock";
    suite = await startMcpTestSuite("conversation-native-elicitation", { withQueue: true });
    await setConfigKey("server.public_base_url", suite.http.baseUrl, { force: true });
    client = await suite.connectElicitation(async (request) => {
      requests += 1;
      expect(request.params.mode).toBe("form");
      expect(request.params.message).toBe("Choose rollout");
      return { action: "accept", content: { value: "canary" } };
    });
  });
  afterAll(async () => {
    await suite.cleanup();
  });
}
