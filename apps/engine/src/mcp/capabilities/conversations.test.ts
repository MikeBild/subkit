import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import { loadDraft } from "../../conversations/draft.ts";
import { conversationElicitations, conversations, mcpTasks } from "../../db/schema/index.ts";
import { createIntakeItem } from "../../knowledge/index.ts";
import { logger } from "../../logging/index.ts";
import { handleConversationTool } from "./conversations.ts";
import {
  finishQueuedConversation,
  nextIntakeUuid,
  principal,
  seedWorkflow,
  setupConversationCapabilities,
  testDb,
} from "./tests/conversations-fixtures.ts";

setupConversationCapabilities();

describe("conversation_start", () => {
  test("non-Tasks client → fast plain working body steering to conversation_get", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    expect(result.isError).toBe(false);
    expect(result.createTaskResult).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      poll_with: string;
      conversation_id: string;
      mcp_task_id: string;
      conversation_path?: string;
    };
    expect(body.status).toBe("working");
    expect(body.poll_with).toBe("conversation_get");
    expect(body.conversation_id.length).toBeGreaterThan(0);
    expect(body.mcp_task_id.length).toBeGreaterThan(0);
    expect(body.conversation_path).toBe(`/cockpit/chat/${body.conversation_id}`);

    const [conv] = await testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, body.conversation_id));
    expect(conv).toBeTruthy();
    const taskRows = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, body.conversation_id));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.kind).toBe("start");
    expect(taskRows[0]?.job_id).toBeTruthy();
  });

  test("selected intake clips start a locked review conversation with an absolute Cockpit handoff", async () => {
    const priorPublicBaseUrl = getConfig().server.public_base_url ?? "";
    await setConfigKey("server.public_base_url", "https://subkit.example/", { force: true });
    try {
      const clip = await createIntakeItem(
        {
          tenant_id: principal.tenant_id,
          actor: { kind: "user", id: principal.id },
          client_request_id: nextIntakeUuid(),
          title: "Collected clip",
          source_url: "https://example.test/clip",
          captured_at: "2026-10-10T07:00:00.000Z",
          body: "Source material remains in the intake record.",
        },
        testDb.db,
      );
      const result = await handleConversationTool({
        db: testDb.db,
        principal,
        name: "conversation_start",
        args: {
          message: "Review the selected clips and propose useful knowledge.",
          intake_item_ids: [clip.id],
        },
      });
      expect(result.isError).toBe(false);
      const body = JSON.parse(result.content[0]?.text ?? "{}") as {
        conversation_id: string;
        conversation_url?: string;
        conversation_path?: string;
      };
      expect(body.conversation_url).toBe(
        `https://subkit.example/cockpit/chat/${body.conversation_id}`,
      );
      expect(body.conversation_path).toBe(`/cockpit/chat/${body.conversation_id}`);
      const draft = await loadDraft(principal.tenant_id, body.conversation_id, testDb.db);
      expect(draft.session).toMatchObject({
        intake_item_ids: [clip.id],
        intake_review_locked: true,
      });
    } finally {
      await setConfigKey("server.public_base_url", priorPublicBaseUrl, { force: true });
    }
  });

  test("selected intake clips return an explicit Cockpit review path when no public URL is configured", async () => {
    const priorPublicBaseUrl = getConfig().server.public_base_url ?? "";
    await setConfigKey("server.public_base_url", "", { force: true });
    try {
      const clip = await createIntakeItem(
        {
          tenant_id: principal.tenant_id,
          actor: { kind: "user", id: principal.id },
          client_request_id: nextIntakeUuid(),
          title: "Path-only collected clip",
          source_url: "https://example.test/path-only-clip",
          captured_at: "2026-10-10T07:00:00.000Z",
          body: "Source material remains in the intake record.",
        },
        testDb.db,
      );
      const result = await handleConversationTool({
        db: testDb.db,
        principal,
        name: "conversation_start",
        args: { message: "Review this clip.", intake_item_ids: [clip.id] },
      });
      const body = JSON.parse(result.content[0]?.text ?? "{}") as {
        conversation_url?: string;
        conversation_path?: string;
        conversation_next_action?: string;
      };
      expect(body.conversation_url).toBeUndefined();
      expect(body.conversation_path).toMatch(/^\/cockpit\/chat\//);
      expect(body.conversation_next_action).toContain("authenticated Cockpit");
    } finally {
      await setConfigKey("server.public_base_url", priorPublicBaseUrl, { force: true });
    }
  });

  test("Tasks-capable client → CreateTaskResult with status working", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
      taskAugmented: true,
    });
    expect(result.isError).toBe(false);
    expect(result.createTaskResult).toBeTruthy();
    const task = result.createTaskResult?.task;
    expect(task?.status).toBe("working");
    expect(task?.taskId.length).toBeGreaterThan(0);
    expect(typeof task?.ttl).toBe("number");
    expect(typeof task?.pollInterval).toBe("number");
  });
});

describe("conversation_start keeps independent dialogs", () => {
  test("identical opening messages always create distinct conversations", async () => {
    const message = "create workflow load-issue-full-details";
    const first = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message },
    });
    const second = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message },
    });
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    const a = JSON.parse(first.content[0]?.text ?? "{}");
    const b = JSON.parse(second.content[0]?.text ?? "{}");
    expect(a.conversation_id).not.toBe(b.conversation_id);
    expect(b.resumed).toBeUndefined();
  });
  test("targeting the same workflow does not implicitly append to another dialog", async () => {
    const target = await seedWorkflow("same-target", [
      {
        id: "existing_step",
        kind: "transform",
        language: "javascript",
        expression: "return input.input;",
      },
    ]);
    const args = {
      workflow_id: target.workflow_id,
      message: "inspect the existing workflow same-target",
    };
    const first = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args,
    });
    const second = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args,
    });
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(JSON.parse(first.content[0]?.text ?? "{}").conversation_id).not.toBe(
      JSON.parse(second.content[0]?.text ?? "{}").conversation_id,
    );
  });
});

describe("conversation_append", () => {
  test("non-Tasks client → fast working body, second mcp_tasks row", async () => {
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

    const appended = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_append",
      args: { conversation_id, message: "another message" },
    });
    expect(appended.isError).toBe(false);
    const body = JSON.parse(appended.content[0]?.text ?? "{}") as { status: string };
    expect(body.status).toBe("working");
    const taskRows = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conversation_id));
    expect(taskRows.length).toBe(2);
  });

  test("a typed answer to a pending dialog is refused with a coded error and a logged cause", async () => {
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
    await testDb.db.insert(conversationElicitations).values({
      tenant_id: principal.tenant_id,
      conversation_id,
      tool_name: "ask_user_confirm",
      summary: "confirm proceed",
      input: { kind: "generic" },
      status: "pending",
    });

    const warnings: Array<Record<string, unknown>> = [];
    const spy = spyOn(logger, "warn").mockImplementation((entry: unknown) => {
      warnings.push(entry as Record<string, unknown>);
    });
    let appended: Awaited<ReturnType<typeof handleConversationTool>>;
    try {
      appended = await handleConversationTool({
        db: testDb.db,
        principal,
        name: "conversation_append",
        args: { conversation_id, message: "einmal erlauben" },
      });
    } finally {
      spy.mockRestore();
    }
    expect(appended.isError).toBe(true);
    expect(appended.content[0]?.text).toBe(
      "pending_elicitation_blocked: resolve the pending dialog before sending another prompt",
    );
    const failure = warnings.find((entry) => entry.action === "mcp.conversation_tool.failed");
    expect(failure).toMatchObject({
      module: "mcp",
      tool: "conversation_append",
      conversation_id,
      error_name: "PendingElicitationBlockedError",
      error_code: "pending_elicitation_blocked",
      error: "resolve the pending dialog before sending another prompt",
    });
    expect(JSON.stringify(failure)).not.toContain("einmal erlauben");
  });
});

describe("validation", () => {
  test("conversation_start without a message → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: {},
    });
    expect(result.isError).toBe(true);
  });

  test("conversation_append without conversation_id → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_append",
      args: { message: "hi" },
    });
    expect(result.isError).toBe(true);
  });

  test("conversation_get without conversation_id → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: {},
    });
    expect(result.isError).toBe(true);
  });

  test("unknown conversation tool name → error", async () => {
    const result = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_does_not_exist",
      args: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unknown conversation tool");
  });
});
