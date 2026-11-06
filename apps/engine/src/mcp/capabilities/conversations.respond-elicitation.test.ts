import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationElicitations, conversations, mcpTasks } from "../../db/schema/index.ts";
import { handleConversationTool } from "./conversations.ts";
import {
  finishQueuedConversation,
  principal,
  setupConversationCapabilities,
  testDb,
} from "./tests/conversations-fixtures.ts";

setupConversationCapabilities();

describe("conversation_respond_elicitation", () => {
  test("non-Tasks client → fast working body for a respond_elicitation turn", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;
    await finishQueuedConversation(conversation_id);

    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "confirm proceed",
        input: { kind: "generic" },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: elicitation.id,
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(false);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as {
      status: string;
      mcp_task_id: string;
    };
    expect(body.status).toBe("working");
    const [row] = await testDb.db
      .select({ kind: mcpTasks.kind })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, body.mcp_task_id));
    expect(row?.kind).toBe("respond_elicitation");

    const [staged] = await testDb.db
      .select({ output: conversationElicitations.output, status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(staged?.status).toBe("pending");
    expect(staged?.output).toEqual({ confirmed: true });
  });

  test("conversation_get passes the password/sensitive form markers through so the client can mask", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "set up the connector" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;
    await finishQueuedConversation(conversation_id);

    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_form",
        summary: "Enter API credentials",
        input: {
          kind: "ask_user_form",
          fields: [
            { name: "base_url", label: "Base URL", type: "text" },
            { name: "api_token", label: "API token", type: "password", sensitive: true },
          ],
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    await testDb.db
      .update(conversations)
      .set({ status: "awaiting_input" })
      .where(eq(conversations.id, conversation_id));

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      input?: { fields?: Array<{ name: string; type: string; sensitive?: boolean }> };
    };
    expect(body.status).toBe("input_required");
    const tokenField = body.input?.fields?.find((f) => f.name === "api_token");
    expect(tokenField?.type).toBe("password");
    expect(tokenField?.sensitive).toBe(true);
  });

  test("respond_elicitation against a non-existent elicitation → error, no orphan task", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;
    await finishQueuedConversation(conversation_id);

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: "00000000-0000-0000-0000-000000000000",
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(true);
    expect(responded.content[0]?.text).toContain("elicitation not found");
  });

  test("refuses an elicitation whose commit_intent carries an approval_id — a model cannot grant a human's approval", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;
    await finishQueuedConversation(conversation_id);

    const approvalId = "11111111-2222-3333-4444-555555555555";
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "Approve the held write?",
        input: {
          kind: "generic",
          commit_intent: {
            kind: "execute_confirmed_tool_call",
            payload: { tool: "wf_post_ledger_entries", approval_id: approvalId },
            description: "Post the ledger entries",
          },
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const tasksBefore = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: elicitation.id,
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(true);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as {
      status: string;
      error_code: string;
      approval_id: string;
      message: string;
      approval_url?: string;
      approval_window: string;
    };
    expect(body.status).toBe("cannot_help");
    expect(body.error_code).toBe("approval_requires_human");
    expect(body.approval_id).toBe(approvalId);
    expect(body.approval_url).toBeUndefined();
    expect(body.message).not.toContain("http");
    expect(body.message).not.toContain("chat UI");
    expect(body.approval_window).toContain("expire 24 hours after they are raised");

    const [row] = await testDb.db
      .select({ status: conversationElicitations.status, output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(row?.status).toBe("pending");
    expect(row?.output).toBeNull();

    const tasksAfter = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));
    expect(tasksAfter).toHaveLength(tasksBefore.length);
  });

  test("when the confirm carries an approval_url, the refusal hands it over instead of dead-ending", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;
    await finishQueuedConversation(conversation_id);

    const approvalId = "22222222-3333-4444-5555-666666666666";
    const approvalUrl = "https://engine.example.test/v1/tool-approvals/decide?grant=skag_probe";
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "Approve the held write?",
        input: {
          kind: "external_write",
          approval_url: approvalUrl,
          commit_intent: {
            kind: "execute_confirmed_tool_call",
            payload: { tool: "wf_post_ledger_entries", approval_id: approvalId },
            description: "Post the ledger entries",
          },
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: { conversation_id, elicitation_id: elicitation.id, output: { confirmed: true } },
    });

    expect(responded.isError).toBe(true);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as {
      error_code: string;
      approval_url?: string;
      message: string;
    };
    expect(body.error_code).toBe("approval_requires_human");
    expect(body.approval_url).toBe(approvalUrl);
    expect(body.message).toContain("approval_url");
    expect(body.message).toContain("after signing in");
    expect(body.message).toContain("is not an identity or an approval by itself");
    expect(body.message).toContain("carries out the held call on its own");
    expect(body.message).not.toContain("chat UI");

    const [row] = await testDb.db
      .select({ status: conversationElicitations.status, output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(row?.status).toBe("pending");
    expect(row?.output).toBeNull();
  });

  test("an ordinary ask_user_confirm elicitation (no approval handle) is still model-resolvable", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;
    await finishQueuedConversation(conversation_id);

    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id,
        tool_name: "ask_user_confirm",
        summary: "proceed?",
        input: { kind: "generic" },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");

    const responded = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_respond_elicitation",
      args: {
        conversation_id,
        elicitation_id: elicitation.id,
        output: { confirmed: true },
      },
    });
    expect(responded.isError).toBe(false);
    const body = JSON.parse(responded.content[0]?.text ?? "{}") as { status: string };
    expect(body.status).toBe("working");
  });
});
