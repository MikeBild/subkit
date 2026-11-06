import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationElicitations, conversations, mcpTasks } from "../../db/schema/index.ts";
import { handleConversationTool } from "./conversations.ts";
import {
  foreignPrincipal,
  principal,
  setupConversationCapabilities,
  testDb,
} from "./tests/conversations-fixtures.ts";

setupConversationCapabilities();

describe("conversation_get — tenant isolation", () => {
  test("a foreign tenant polling another tenant's conversation gets conversation-not-found", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversationId = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const foreignGet = await handleConversationTool({
      db: testDb.db,
      principal: foreignPrincipal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    expect(foreignGet.isError).toBe(true);
    expect(foreignGet.content[0]?.text).toContain("conversation not found");

    const ownerGet = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    expect(ownerGet.isError).toBe(false);
  });

  test("conversation_get for a non-existent conversation id → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("conversation not found");
  });

  test("a foreign tenant cannot append to another tenant's conversation", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversationId = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const foreignAppend = await handleConversationTool({
      db: testDb.db,
      principal: foreignPrincipal,
      name: "conversation_append",
      args: { conversation_id: conversationId, message: "intrude" },
    });
    expect(foreignAppend.isError).toBe(true);
    const foreignTasks = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.tenant_id, foreignPrincipal.tenant_id));
    expect(foreignTasks).toHaveLength(0);
  });
});

describe("conversation_get — derived status before any task settles", () => {
  test("a fresh backgrounded turn reports working until the worker runs", async () => {
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversationId = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as { status: string };
    expect(body.status).toBe("working");
  });

  test("a settled no-op save turn reports completed without committed_workflow_id", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "active",
        draft: {},
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "respond_elicitation",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
      result: {
        conversation_id: conv.id,
        status: "active",
        events: [
          {
            type: "tool_result",
            tool: "save_workflow_draft",
            output: {
              ok: true,
              data: {
                already_persisted: true,
                version_changed: false,
                workflow_id: "wf_existing",
              },
            },
          },
        ],
      },
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      committed_workflow_id?: string;
      result?: { committed_workflow_id?: string; status?: string };
    };
    expect(body.status).toBe("completed");
    expect(body.committed_workflow_id).toBeUndefined();
    expect(body.result?.status).toBe("active");
    expect(body.result?.committed_workflow_id).toBeUndefined();
  });
});

describe("conversation_get — respond_elicitation in-flight vs crashed", () => {
  async function seedAwaitingInputWithPendingElicitation(): Promise<{
    conversation_id: string;
    elicitation_id: string;
  }> {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "awaiting_input",
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id: conv.id,
        tool_name: "ask_user_confirm",
        summary: "confirm proceed",
        input: { kind: "generic" },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");
    return { conversation_id: conv.id, elicitation_id: elicitation.id };
  }

  test("an in-flight respond_elicitation (job enqueued, no result) reports working — not a re-prompt", async () => {
    const { conversation_id } = await seedAwaitingInputWithPendingElicitation();
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id,
      turn_seq: 1,
      kind: "respond_elicitation",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
      job_id: "job-inflight",
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as { status: string };
    expect(body.status).toBe("working");
  });

  test("a CRASHED respond_elicitation (no job_id) re-surfaces the pending form instead of working forever", async () => {
    const { conversation_id, elicitation_id } = await seedAwaitingInputWithPendingElicitation();
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id,
      turn_seq: 1,
      kind: "respond_elicitation",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      pending_elicitation_id?: string;
    };
    expect(body.status).toBe("input_required");
    expect(body.pending_elicitation_id).toBe(elicitation_id);
  });
});

describe("conversation_get — native MCP elicitation delivery", () => {
  async function seedNativeChoice(): Promise<{ conversation_id: string; elicitation_id: string }> {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "awaiting_input",
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const [elicitation] = await testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: principal.tenant_id,
        conversation_id: conv.id,
        tool_name: "ask_user_choice",
        summary: "choose rollout",
        input: {
          question: "Choose rollout",
          options: [
            { value: "canary", label: "Canary" },
            { value: "full", label: "Full" },
          ],
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("seed elicitation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
      result: { conversation_id: conv.id, status: "awaiting_input", events: [] },
    });
    return { conversation_id: conv.id, elicitation_id: elicitation.id };
  }

  test("delivers the persisted choice through the live MCP request and queues its answer", async () => {
    const { conversation_id, elicitation_id } = await seedNativeChoice();
    let calls = 0;
    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
      nativeElicitation: {
        elicitForm: async (params) => {
          calls += 1;
          expect(params.requestedSchema.properties.value).toMatchObject({
            type: "string",
            enum: ["canary", "full"],
          });
          return { action: "accept", content: { value: "canary" } };
        },
      },
    });
    expect(got.isError).toBe(false);
    expect(calls).toBe(1);
    const [row] = await testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation_id));
    expect(row?.protocol_native).toBe(true);
    expect(row?.delivery_attempts).toBe(1);
    expect(row?.output).toEqual({ value: "canary", option_index: 0 });
    const tasks = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));
    expect(tasks.some((task) => task.kind === "respond_elicitation" && task.job_id)).toBe(true);
  });

  test("a concurrent poll sees the durable lease and does not open a second dialog", async () => {
    const { conversation_id } = await seedNativeChoice();
    let releaseFirst: (() => void) | undefined;
    const firstAnswer = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const nativeElicitation = {
      elicitForm: async () => {
        calls += 1;
        await firstAnswer;
        return { action: "cancel" as const };
      },
    };
    const first = handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
      nativeElicitation,
    });
    while (calls === 0) await Bun.sleep(5);
    const second = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id },
      nativeElicitation,
    });
    const secondBody = JSON.parse(second.content[0]?.text ?? "{}") as {
      phase?: string;
    };
    expect(secondBody.phase).toBe("awaiting_human_input");
    expect(calls).toBe(1);
    releaseFirst?.();
    await first;
  });
});
