import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { withWorkflowPersisted } from "../../conversations/authoring-state.ts";
import { appendSnapshot, loadDraft } from "../../conversations/draft.ts";
import { finishConversationTurn } from "../../conversations/turns.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
  conversationTurns,
  mcpTasks,
  tenants,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createIntakeItem } from "../../knowledge/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { logger } from "../../logging/logger.ts";
import { startBoss, stopBoss } from "../../queue/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { stampMcpTaskProgress } from "../tasks/store.ts";
import { handleConversationTool } from "./conversations.ts";

const nextIntakeUuid = createDeterministicUuidFactory(0x1a2b_3c4d);

let testDb: TestDb;
let principal: ResolvedPrincipal;
let foreignPrincipal: ResolvedPrincipal;

async function finishQueuedConversation(conversation_id: string) {
  const rows = await testDb.db
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.conversation_id, conversation_id));
  for (const row of rows)
    await finishConversationTurn(testDb.db, principal.tenant_id, conversation_id, row.id);
}

async function ensureConfig(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
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
    .values({
      tenant_id: t.id,
      email: "ct@test.local",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  principal = {
    kind: "user",
    id: u.id,
    tenant_id: t.id,
    provider: "api_key",
    roles: ["admin"],
  };
  const [t2] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-convtool-foreign", display_name: "ConvTool Foreign" })
    .returning();
  if (!t2) throw new Error("seed foreign tenant failed");
  const [u2] = await testDb.db
    .insert(users)
    .values({
      tenant_id: t2.id,
      email: "foreign@test.local",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
    .returning();
  if (!u2) throw new Error("seed foreign user failed");
  foreignPrincipal = {
    kind: "user",
    id: u2.id,
    tenant_id: t2.id,
    provider: "api_key",
    roles: ["admin"],
  };
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

  test("a pending dialog blocks the append with a coded error and a logged cause", async () => {
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
        args: { conversation_id, message: "another message" },
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
    expect(JSON.stringify(failure)).not.toContain("another message");
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

async function seedWorkflow(
  slug: string,
  steps: Array<Record<string, unknown>>,
): Promise<{ workflow_id: string; version_id: string; slug: string; name: string }> {
  const name = `wf ${slug}`;
  const [workflow] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: principal.tenant_id, slug, name, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: principal.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: { name, slug, steps },
    })
    .returning();
  if (!version) throw new Error("workflow version insert failed");
  await testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return { workflow_id: workflow.id, version_id: version.id, slug, name };
}

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

describe("conversation_get — working heartbeat", () => {
  test("a non-terminal turn reports numeric elapsed_ms + the newest action", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
    });
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool: "dry_run_workflow",
      input: { step_id: "shape" },
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
      elapsed_ms: unknown;
      last_action: unknown;
      phase: unknown;
      step: unknown;
    };
    expect(body.status).toBe("working");
    expect(typeof body.elapsed_ms).toBe("number");
    expect(body.elapsed_ms as number).toBeGreaterThanOrEqual(0);
    expect(body.last_action).toBe("dry_run_workflow");
    expect(body.phase).toBe("validating");
    expect(body.step).toBe("shape");
  });

  test.each([
    ["author_workflow", "building"],
    ["edit_workflow_patch", "editing"],
  ])("%s maps to phase:%s", async (tool, expectedPhase) => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
    });
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool,
      input: {},
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      last_action: unknown;
      phase: unknown;
    };
    expect(body.last_action).toBe(tool);
    expect(body.phase).toBe(expectedPhase);
  });

  test("a task with no tool calls yet reports phase:starting with null last_action", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      phase: unknown;
      last_action: unknown;
      elapsed_ms: unknown;
    };
    expect(body.status).toBe("working");
    expect(body.phase).toBe("starting");
    expect(body.last_action).toBeNull();
    expect(typeof body.elapsed_ms).toBe("number");
  });
});

describe("conversation_get — worker-stamped heartbeat (Option-B)", () => {
  test("the stamp is authoritative over the newest tool-call derivation", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
    });
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool: "dry_run_workflow",
      input: { step_id: "shape" },
    });
    await stampMcpTaskProgress(
      principal.tenant_id,
      conv.id,
      "author_workflow",
      { id: "wf-slug" },
      testDb.db,
    );

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      status: string;
      phase: unknown;
      last_action: unknown;
      step: unknown;
    };
    expect(body.status).toBe("working");
    expect(body.phase).toBe("building");
    expect(body.last_action).toBe("author_workflow");
    expect(body.step).toBe("wf-slug");
  });

  test("a moving turn advances the stamped phase + heartbeat_at monotonically", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
    });

    await stampMcpTaskProgress(principal.tenant_id, conv.id, "author_workflow", {}, testDb.db);
    const [first] = await testDb.db
      .select({ phase: mcpTasks.phase, heartbeat_at: mcpTasks.heartbeat_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conv.id));
    if (!first?.heartbeat_at) throw new Error("first stamp did not land");
    expect(first.phase).toBe("building");

    await new Promise((r) => setTimeout(r, 5)); // allow-wall-clock
    await stampMcpTaskProgress(principal.tenant_id, conv.id, "save_workflow_draft", {}, testDb.db);
    const [second] = await testDb.db
      .select({ phase: mcpTasks.phase, heartbeat_at: mcpTasks.heartbeat_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conv.id));
    if (!second?.heartbeat_at) throw new Error("second stamp did not land");
    expect(second.phase).toBe("committing");
    expect(second.heartbeat_at.getTime()).toBeGreaterThanOrEqual(first.heartbeat_at.getTime());

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as { phase: unknown };
    expect(body.phase).toBe("committing");
  });

  test("a null stamp falls back to the tool-call derivation", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
    });
    await testDb.db.insert(conversationToolCalls).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      tool: "dry_run_workflow",
      input: { step_id: "shape" },
    });

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_get",
      args: { conversation_id: conv.id },
    });
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      phase: unknown;
      last_action: unknown;
      step: unknown;
    };
    expect(body.phase).toBe("validating");
    expect(body.last_action).toBe("dry_run_workflow");
    expect(body.step).toBe("shape");
  });

  test("a stamp never resurrects a terminal (result-bearing) task row", async () => {
    const [conv] = await testDb.db
      .insert(conversations)
      .values({ tenant_id: principal.tenant_id, owner_id: principal.id, status: "active" })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    await testDb.db.insert(mcpTasks).values({
      tenant_id: principal.tenant_id,
      conversation_id: conv.id,
      turn_seq: 1,
      kind: "start",
      actor_id: principal.id,
      actor_kind: "user",
      request_source: "mcp",
      result: { conversation_id: conv.id, status: "committed", events: [] },
    });

    await stampMcpTaskProgress(principal.tenant_id, conv.id, "author_workflow", {}, testDb.db);
    const [row] = await testDb.db
      .select({ phase: mcpTasks.phase, heartbeat_at: mcpTasks.heartbeat_at })
      .from(mcpTasks)
      .where(eq(mcpTasks.conversation_id, conv.id));
    expect(row?.phase ?? null).toBeNull();
    expect(row?.heartbeat_at ?? null).toBeNull();
  });
});

describe("conversation_commit — inline auto-commit reconciliation", () => {
  test("null target_workflow_id but a bound draft resolves the committed workflow (not the error)", async () => {
    const wf = await seedWorkflow("hb-committed", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: null,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const boundDraft = withWorkflowPersisted(
      { workflow: { name: wf.name, steps: [] } },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, boundDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      workflow_id: string;
      conversation_id: string;
      committed?: { workflow_version_id: string; version: number; steps_present: number };
      draft_state?: string;
      verified_against_draft?: boolean;
      note?: string;
      usage?: unknown;
    };
    expect(body.workflow_id).toBe(wf.workflow_id);
    expect(body.conversation_id).toBe(conv.id);
    expect(body.usage).toBeDefined();
    expect(body.committed).toEqual(
      expect.objectContaining({
        workflow_version_id: wf.version_id,
        version: 1,
        steps_present: 1,
      }),
    );
    expect(body.draft_state).toBe("empty_draft");
    expect(body.verified_against_draft).toBe(false);
    expect(body.note).toBeDefined();
  });

  test("a stamped target_workflow_id still commits and carries usage", async () => {
    const wf = await seedWorkflow("hb-stamped", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(false);
    const body = JSON.parse(got.content[0]?.text ?? "{}") as {
      workflow_id: string;
      committed?: { workflow_version_id: string; version: number; steps_present: number };
    };
    expect(body.workflow_id).toBe(wf.workflow_id);
    const [wfRow] = await testDb.db
      .select({ current_version_id: workflows.current_version_id })
      .from(workflows)
      .where(eq(workflows.id, wf.workflow_id));
    const [vRow] = await testDb.db
      .select({ version: workflowVersions.version, dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, wf.version_id));
    expect(body.committed?.workflow_version_id).toBe(wfRow?.current_version_id ?? "");
    expect(body.committed?.version).toBe(vRow?.version ?? -1);
    expect(body.committed?.steps_present).toBe(
      ((vRow!.dag as { steps?: unknown[] })?.steps ?? []).length,
    );
  });

  test("a workflow with no persisted version returns NOT COMMITTED, not success", async () => {
    const [workflow] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: principal.tenant_id,
        slug: "hb-unversioned",
        name: "wf hb-unversioned",
        lifecycle: "draft",
      })
      .returning();
    if (!workflow) throw new Error("workflow insert failed");
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: workflow.id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text ?? "").toContain("NOT COMMITTED");
    expect(got.content[0]?.text ?? "").toContain("no persisted version");
  });

  test("an unreadable persisted dag returns COMMIT UNVERIFIED, not success", async () => {
    const wf = await seedWorkflow("hb-corrupt", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    await testDb.db
      .update(workflowVersions)
      .set({ dag: { not_a: "workflow" } })
      .where(eq(workflowVersions.id, wf.version_id));
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "committed",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const boundDraft: DraftDocument = withWorkflowPersisted(
      {
        workflow: {
          name: wf.name,
          slug: wf.slug,
          steps: [
            { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
          ],
        },
      },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, boundDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text ?? "").toContain("COMMIT UNVERIFIED");
  });

  test("a structural draft still returns the NOT COMMITTED directive error", async () => {
    const wf = await seedWorkflow("hb-structural", [
      { id: "shape", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const [conv] = await testDb.db
      .insert(conversations)
      .values({
        tenant_id: principal.tenant_id,
        owner_id: principal.id,
        status: "active",
        target_workflow_id: wf.workflow_id,
      })
      .returning();
    if (!conv) throw new Error("seed conversation failed");
    const dirtyDraft: DraftDocument = withWorkflowPersisted(
      {
        workflow: {
          name: wf.name,
          slug: wf.slug,
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { changed: true };",
            },
          ],
        },
      },
      {
        kind: "workflow",
        id: wf.workflow_id,
        slug: wf.slug,
        name: wf.name,
        version_id: wf.version_id,
        version: 1,
        environment: null,
        saved_at: "2026-07-01T00:00:00.000Z",
      },
    );
    await appendSnapshot(principal.tenant_id, conv.id, dirtyDraft, testDb.db);

    const got = await handleConversationTool({
      db: testDb.db,
      principal,
      name: "conversation_commit",
      args: { conversation_id: conv.id },
    });
    expect(got.isError).toBe(true);
    expect(got.content[0]?.text).toContain("NOT COMMITTED");
  });
});
