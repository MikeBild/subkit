// MCP conversation tool handlers — async Tasks fast-return contract.
//
// Pins SEP-1686 step 7:
//   - the three turn-driving tools return a fast `working` status and
//     never run the model loop inline,
//   - a Tasks-capable call (`taskAugmented: true`) returns a
//     `CreateTaskResult`,
//   - a non-Tasks call returns a plain `CallToolResult` text body that
//     steers the client to `conversation_get`,
//   - each call inserts exactly one `mcp_tasks` row + enqueues a job.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, loadConfig } from "../../config/loader.ts";
import {
  conversationElicitations,
  conversations,
  mcpTasks,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { startBoss, stopBoss } from "../../queue/index.ts";
import { handleConversationTool } from "./conversations.ts";

let testDb: TestDb;
let principal: ResolvedPrincipal;
let foreignPrincipal: ResolvedPrincipal;

async function ensureConfig(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    // not loaded
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-convtool-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/convtool-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  await ensureConfig();
  resetMockProvider();
  testDb = await createTestDb("mcp_conv_tool");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-convtool", display_name: "ConvTool" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  const [u] = await testDb.db
    .insert(users)
    .values({ tenant_id: t.id, email: "ct@test.local", role: "admin" })
    .returning();
  if (!u) throw new Error("seed user failed");
  principal = {
    kind: "user",
    id: u.id,
    tenant_id: t.id,
    provider: "api_key",
    roles: ["admin"],
  };
  // A second tenant — used for the cross-tenant negative tests.
  const [t2] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-convtool-foreign", display_name: "ConvTool Foreign" })
    .returning();
  if (!t2) throw new Error("seed foreign tenant failed");
  const [u2] = await testDb.db
    .insert(users)
    .values({ tenant_id: t2.id, email: "foreign@test.local", role: "admin" })
    .returning();
  if (!u2) throw new Error("seed foreign user failed");
  foreignPrincipal = {
    kind: "user",
    id: u2.id,
    tenant_id: t2.id,
    provider: "api_key",
    roles: ["admin"],
  };
  // The handler enqueues a `conversation.run-turn` job via getBoss().
  // No worker is registered — the job sits in the queue; this suite
  // only asserts the fast-return shape, not the turn outcome.
  await startBoss({ connectionString: testDb.url });
});

afterAll(async () => {
  await stopBoss(5_000);
  await testDb.cleanup();
});

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
    };
    expect(body.status).toBe("working");
    expect(body.poll_with).toBe("conversation_get");
    expect(body.conversation_id.length).toBeGreaterThan(0);
    expect(body.mcp_task_id.length).toBeGreaterThan(0);

    // Exactly one conversation row + one mcp_tasks row were created.
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
    // The job was enqueued — job_id is recorded on the row.
    expect(taskRows[0]?.job_id).toBeTruthy();
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

describe("conversation_append", () => {
  test("non-Tasks client → fast working body, second mcp_tasks row", async () => {
    // Seed a conversation via the start handler.
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

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
});

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

    // Seed a real pending elicitation — the handler stages the answer
    // onto it before enqueue, so the row must exist and be `pending`.
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

    // S3: the answer was staged onto the elicitation row's `output`
    // BEFORE enqueue — the job envelope carries no payload body. The
    // row stays `pending` so the worker still drives the real resolve.
    const [staged] = await testDb.db
      .select({ output: conversationElicitations.output, status: conversationElicitations.status })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect(staged?.status).toBe("pending");
    expect(staged?.output).toEqual({ confirmed: true });
  });

  test("respond_elicitation against a non-existent elicitation → error, no orphan task", async () => {
    // The handler stages the answer onto the elicitation row before
    // enqueue; a missing row must surface a structured error rather
    // than enqueue a job that can never resolve (S3/S4 root cause).
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversation_id = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

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

describe("conversation_get — tenant isolation", () => {
  test("a foreign tenant polling another tenant's conversation gets conversation-not-found", async () => {
    // Tenant A starts a conversation.
    const started = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_start",
      args: { message: "list users" },
    });
    const conversationId = (
      JSON.parse(started.content[0]?.text ?? "{}") as { conversation_id: string }
    ).conversation_id;

    // Tenant B polls the same conversation id. `conversation_get`
    // resolves the conversation tenant-scoped — a foreign tenant must
    // not see it.
    const foreignGet = await handleConversationTool({
      db: testDb.db,
      principal: foreignPrincipal,
      name: "conversation_get",
      args: { conversation_id: conversationId },
    });
    expect(foreignGet.isError).toBe(true);
    expect(foreignGet.content[0]?.text).toContain("conversation not found");

    // The owning tenant still sees it.
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
    // No mcp_tasks row leaked to the foreign tenant.
    const foreignTasks = await testDb.db
      .select()
      .from(mcpTasks)
      .where(eq(mcpTasks.tenant_id, foreignPrincipal.tenant_id));
    expect(foreignTasks).toHaveLength(0);
  });
});

describe("conversation_get — derived status before any task settles", () => {
  test("a fresh backgrounded turn reports working until the worker runs", async () => {
    // No worker is registered in this suite — the job sits queued.
    // `conversation_get` must report `working` (the task row exists but
    // has neither result nor failure nor cancel).
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
