import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversations, conversationToolCalls, mcpTasks } from "../../db/schema/index.ts";
import { stampMcpTaskProgress } from "../tasks/store.ts";
import { handleConversationTool } from "./conversations.ts";
import {
  principal,
  setupConversationCapabilities,
  testDb,
} from "./tests/conversations-fixtures.ts";

setupConversationCapabilities();

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
