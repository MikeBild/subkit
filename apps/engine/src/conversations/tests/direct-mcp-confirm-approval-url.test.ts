import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { conversationElicitations, conversations, toolApprovals } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import {
  approvalHandleFromElicitationInput,
  elicitationInputForClient,
} from "../tools/ask-user/commit-intent.ts";
import { askUserConfirmTool } from "../tools/ask-user/confirm.ts";
import type { ToolContext } from "../tools/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  process.env.MASTER_KEY = "a".repeat(64);
  ctx = await createConversationTestCtx("direct-mcp-confirm-url");
  await setConfigKey("server.public_base_url", "https://engine.example.test", { force: true });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("direct MCP ask_user_confirm browser fallback", () => {
  test("save_workflow_draft mints a portal URL and keeps the handle server-side", async () => {
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, owner_id: ctx.user_id, status: "active" })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error("failed to seed conversation");

    const principal = {
      provider: "conversation_tool" as const,
      kind: "user" as const,
      id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      roles: ["admin"],
    };
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      actor_id: ctx.user_id,
      principal,
      surface: "mcp",
      permission_mode: "ask",
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
      getDraft: () => ({
        mode: "workflow_authoring",
        workflow: { name: "Canary", slug: "canary", steps: [] },
      }),
      setDraft: async () => undefined,
    };

    const result = await askUserConfirmTool.execute(toolCtx, {
      question: "Save version 2?",
      kind: "save_workflow_draft",
      commit_intent: {
        kind: "save_workflow_draft",
        payload: { target_workflow_id: "00000000-0000-4000-8000-000000000001" },
        description: "Save version 2.",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.pause) throw new Error("expected a pending confirmation");
    const clientInput = result.pause.input as Record<string, unknown>;
    expect(clientInput.approval_url).toMatch(
      /^https:\/\/engine\.example\.test\/v1\/tool-approvals\/decide\?grant=skag_/,
    );
    expect(approvalHandleFromElicitationInput(clientInput)).toBeNull();

    const [elicitation] = await ctx.testDb.db.select().from(conversationElicitations);
    expect(elicitation?.status).toBe("pending");
    const approvalId = approvalHandleFromElicitationInput(elicitation?.input);
    expect(approvalId).not.toBeNull();
    expect(elicitationInputForClient(elicitation?.input)).toEqual(clientInput);

    const [approval] = await ctx.testDb.db.select().from(toolApprovals);
    expect(approvalId).not.toBeNull();
    expect(approval?.id).toBe(approvalId ?? undefined);
    expect(approval?.tool).toBe("save_workflow_draft");
    expect(approval?.granted_at).toBeNull();
    expect(approval?.declined_at).toBeNull();
    expect(approval?.consumed_at).toBeNull();
  });

  test("fails closed when no authenticated principal can own the approval", async () => {
    const [conversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error("failed to seed anonymous conversation");

    const approvalsBefore = await ctx.testDb.db.select().from(toolApprovals);
    const elicitationsBefore = await ctx.testDb.db.select().from(conversationElicitations);
    const toolCtx: ToolContext = {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      actor_id: null,
      surface: "mcp",
      permission_mode: "ask",
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db: ctx.testDb.db,
      }),
      getDraft: () => ({
        mode: "workflow_authoring",
        workflow: { name: "Anonymous canary", slug: "anonymous-canary", steps: [] },
      }),
      setDraft: async () => undefined,
    };

    const result = await askUserConfirmTool.execute(toolCtx, {
      question: "Save this draft?",
      kind: "save_workflow_draft",
      commit_intent: {
        kind: "save_workflow_draft",
        payload: {},
        description: "Save the anonymous draft.",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("anonymous confirmation unexpectedly succeeded");
    expect(result.error_code).toBe("principal_required");
    expect(await ctx.testDb.db.select().from(toolApprovals)).toHaveLength(approvalsBefore.length);
    expect(await ctx.testDb.db.select().from(conversationElicitations)).toHaveLength(
      elicitationsBefore.length,
    );
  });
});
