import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitationCompleteNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { markConnectorNativeUrlElicitationsComplete } from "../../conversations/native-url-elicitation.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  mcpTasks,
  workflows,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

describe("MCP conversation native elicitation — real Streamable HTTP", () => {
  let suite: McpTestSuite;
  let client: Client;
  let requests = 0;

  beforeAll(async () => {
    process.env.LLM_PROVIDER = "mock";
    suite = await startMcpTestSuite("conversation-native-elicitation", { withQueue: true });
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

  test("a DB-paused worker prompt becomes elicitation/create on conversation_get", async () => {
    const [conversation] = await suite.http.db
      .insert(conversations)
      .values({
        tenant_id: suite.http.tenantId,
        owner_id: suite.http.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("conversation seed failed");
    const [elicitation] = await suite.http.db
      .insert(conversationElicitations)
      .values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        tool_name: "ask_user_choice",
        summary: "Choose rollout",
        input: {
          question: "Choose rollout",
          options: [
            { value: "canary", label: "Canary" },
            { value: "full", label: "Full" },
          ],
        },
      })
      .returning();
    if (!elicitation) throw new Error("elicitation seed failed");
    await suite.http.db.insert(mcpTasks).values({
      tenant_id: suite.http.tenantId,
      conversation_id: conversation.id,
      turn_seq: 1,
      kind: "start",
      actor_id: suite.http.userId,
      request_source: "mcp",
      result: { conversation_id: conversation.id, status: "awaiting_input", events: [] },
    });

    const result = await client.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversation.id },
    });
    expect(result.isError).toBe(false);
    expect(requests).toBe(1);

    const [stored] = await suite.http.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(stored?.protocol_native).toBe(true);
    expect(stored?.output).toEqual({ value: "canary", option_index: 0 });
    expect(stored?.delivery_attempts).toBe(1);
  });

  test("a native decline is persisted and audited as a rejection", async () => {
    const declineClient = await suite.connectElicitation(async (request) => {
      expect(request.params.mode).toBe("form");
      return { action: "decline" };
    });
    const [conversation] = await suite.http.db
      .insert(conversations)
      .values({
        tenant_id: suite.http.tenantId,
        owner_id: suite.http.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("conversation seed failed");
    const [elicitation] = await suite.http.db
      .insert(conversationElicitations)
      .values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        tool_name: "ask_user_choice",
        summary: "Decline rollout",
        input: {
          question: "Decline rollout",
          options: [{ value: "stable", label: "Stable" }],
        },
      })
      .returning();
    if (!elicitation) throw new Error("elicitation seed failed");
    await suite.http.db.insert(mcpTasks).values({
      tenant_id: suite.http.tenantId,
      conversation_id: conversation.id,
      turn_seq: 1,
      kind: "start",
      actor_id: suite.http.userId,
      request_source: "mcp",
      result: { conversation_id: conversation.id, status: "awaiting_input", events: [] },
    });

    const result = await declineClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversation.id },
    });
    expect(result.isError).toBe(false);

    const stored = await waitFor(
      async () => {
        const [row] = await suite.http.db
          .select()
          .from(conversationElicitations)
          .where(
            and(
              eq(conversationElicitations.tenant_id, suite.http.tenantId),
              eq(conversationElicitations.id, elicitation.id),
            ),
          );
        return row?.status === "cancelled" ? row : null;
      },
      { tries: 500, sleepMs: 10, label: "native decline resolution" },
    );
    expect(stored.decision_reason).toBe("user_declined");
    const [audit] = await suite.http.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.resource_type, "conversation_elicitation"),
          eq(auditLog.resource_id, elicitation.id),
          eq(auditLog.action, "approval.rejected"),
        ),
      );
    expect(audit?.reason).toBe("user_declined");
  });

  test("tasks/get delivers native input and rearms the same task", async () => {
    let taskRequests = 0;
    const tasksClient = await suite.connectTasksElicitation(async (request) => {
      taskRequests += 1;
      expect(request.params.mode).toBe("form");
      expect(request.params.message).toBe("Approve rollout?");
      return { action: "accept", content: { confirmed: true } };
    });
    const [conversation] = await suite.http.db
      .insert(conversations)
      .values({
        tenant_id: suite.http.tenantId,
        owner_id: suite.http.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("conversation seed failed");
    const [elicitation] = await suite.http.db
      .insert(conversationElicitations)
      .values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        tool_name: "ask_user_confirm",
        summary: "Approve rollout?",
        input: { question: "Approve rollout?" },
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
        request_source: "mcp",
        result: { conversation_id: conversation.id, status: "awaiting_input", events: [] },
      })
      .returning();
    if (!taskRow) throw new Error("task seed failed");

    const task = await tasksClient.experimental.tasks.getTask(taskRow.id);

    expect(taskRequests).toBe(1);
    expect(["working", "completed"]).toContain(task.status);
    const [storedElicitation] = await suite.http.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, suite.http.tenantId),
          eq(conversationElicitations.id, elicitation.id),
        ),
      );
    expect(storedElicitation?.output).toEqual({ confirmed: true });
    const taskRows = await suite.http.db
      .select()
      .from(mcpTasks)
      .where(
        and(
          eq(mcpTasks.tenant_id, suite.http.tenantId),
          eq(mcpTasks.conversation_id, conversation.id),
        ),
      );
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.id).toBe(taskRow.id);
    expect(taskRows[0]?.kind).toBe("respond_elicitation");
  });

  test("conversation_get sends credential setup through URL-mode elicitation", async () => {
    const setupUrl = "https://engine.test/v1/connectors/example/credentials/setup?grant=opaque";
    let urlRequests = 0;
    let completionNotifications = 0;
    const urlClient = await suite.connectUrlElicitation(async (request) => {
      urlRequests += 1;
      expect(request.params.mode).toBe("url");
      if (request.params.mode !== "url") throw new Error("expected URL elicitation");
      expect(request.params.url).toBe(setupUrl);
      expect(request.params.elicitationId).toBeTruthy();
      return { action: "accept" };
    });
    urlClient.setNotificationHandler(ElicitationCompleteNotificationSchema, () => {
      completionNotifications += 1;
    });
    const [conversation] = await suite.http.db
      .insert(conversations)
      .values({
        tenant_id: suite.http.tenantId,
        owner_id: suite.http.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("conversation seed failed");
    const [elicitation] = await suite.http.db
      .insert(conversationElicitations)
      .values({
        tenant_id: suite.http.tenantId,
        conversation_id: conversation.id,
        tool_name: "ask_user_confirm",
        summary: "Reconnect connector",
        input: {
          question: "Did you reconnect the connector?",
          summary: "Reconnect connector securely",
          setup_url: setupUrl,
          connector_id: "example",
        },
      })
      .returning();
    if (!elicitation) throw new Error("elicitation seed failed");
    await suite.http.db.insert(mcpTasks).values({
      tenant_id: suite.http.tenantId,
      conversation_id: conversation.id,
      turn_seq: 1,
      kind: "start",
      actor_id: suite.http.userId,
      request_source: "mcp",
      result: { conversation_id: conversation.id, status: "awaiting_input", events: [] },
    });

    const result = await urlClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversation.id },
    });

    expect(result.isError).toBe(false);
    expect(urlRequests).toBe(1);
    let [stored] = await suite.http.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(stored?.output).toBeNull();
    expect(stored?.delivery_last_error).toBe("url_accepted");
    expect(stored?.protocol_native).toBe(true);

    await markConnectorNativeUrlElicitationsComplete(
      {
        tenant_id: suite.http.tenantId,
        connector_id: "example",
        outcome: "succeeded",
      },
      suite.http.db,
    );
    for (let attempt = 0; completionNotifications === 0 && attempt < 20; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(completionNotifications).toBe(1);

    const resumed = await urlClient.callTool({
      name: "conversation_get",
      arguments: { conversation_id: conversation.id },
    });
    expect(resumed.isError).toBe(false);
    [stored] = await suite.http.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(stored?.output).toEqual({ confirmed: true });
    expect(urlRequests).toBe(1);
  });

  test("a native human approval resumes the worker and performs the gated write", async () => {
    let approvalRequests = 0;
    const approvalClient = await suite.connectElicitation(async (request) => {
      approvalRequests += 1;
      expect(request.params.mode).toBe("form");
      return { action: "accept", content: { confirmed: true } };
    });
    const workflow = await suite.seedWorkflow({
      name: "Native approval delete target",
      slug: "native-approval-delete-target",
      steps: [{ id: "wait", kind: "wait", duration_ms: 1 }],
    });
    const [conversation] = await suite.http.db
      .insert(conversations)
      .values({
        tenant_id: suite.http.tenantId,
        owner_id: suite.http.userId,
        status: "active",
      })
      .returning();
    if (!conversation) throw new Error("conversation seed failed");
    getMockProvider().setConversePlan(conversation.id, [
      { tool: "delete_workflow", args: { slug: workflow.slug } },
    ]);

    const append = await approvalClient.callTool({
      name: "conversation_append",
      arguments: { conversation_id: conversation.id, message: "Delete the workflow" },
      _meta: { sk_permission_mode: "ask" },
    });
    expect(append.isError).toBe(false);

    let terminalStatus: string | null = null;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const poll = await approvalClient.callTool({
        name: "conversation_get",
        arguments: { conversation_id: conversation.id },
      });
      const pollResult = poll as { content?: Array<{ type: string; text?: string }> };
      const item = pollResult.content?.[0];
      const body = JSON.parse(item?.type === "text" ? (item.text ?? "{}") : "{}") as {
        status?: string;
      };
      if (body.status === "completed" || body.status === "failed") {
        terminalStatus = body.status;
        break;
      }
      await Bun.sleep(25);
    }

    expect(approvalRequests).toBe(1);
    expect(terminalStatus).toBe("completed");
    const [storedWorkflow] = await suite.http.db
      .select({ deleted_at: workflows.deleted_at })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, suite.http.tenantId), eq(workflows.id, workflow.id)));
    expect(storedWorkflow?.deleted_at).toBeInstanceOf(Date);
  }, 30_000);
});
