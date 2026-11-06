import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { toFileId } from "../../api/files-schemas.ts";
import {
  auditLog,
  chatIdentities,
  chatWorkspaces,
  conversationMessages,
  conversations,
  conversationToolCalls,
  executions,
  fileLinks,
  workflows as workflowsTable,
  workflowVersions,
} from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { handleChatEvent } from "../dispatcher.ts";
import type { ChatEvent } from "../types.ts";
import { ctx, detBytes, FakeSlackAdapter, setupChatDispatcher } from "./dispatcher-fixtures.ts";

setupChatDispatcher();

describe("chat dispatcher", () => {
  test("existing thread resolves a tenant attachment with the mapped chat principal", async () => {
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: "T_ATTACH",
      bot_ciphertext: detBytes(2),
      bot_iv: detBytes(2),
      bot_auth_tag: detBytes(2),
    });
    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      platform: "slack",
      workspace_id: "T_ATTACH",
      platform_user_id: "U_ATTACH",
    });
    const [unrelatedConversation] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    if (!unrelatedConversation) throw new Error("unrelated conversation missing");
    const tenantFile = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: unrelatedConversation.id,
      filename: "shared-brief.txt",
      content: "Shared brief content",
      slug: "shared-brief",
    });

    const adapter = new FakeSlackAdapter();
    const event: ChatEvent = {
      platform: "slack",
      workspace_id: "T_ATTACH",
      channel_id: "C_ATTACH",
      thread_id: "1700000000.000200",
      user_id: "U_ATTACH",
      kind: "mention",
      text: "Start a conversation",
      raw: {},
    };
    const initial = await handleChatEvent({ db: ctx.testDb.db, adapter }, event);
    expect(initial.status).toBe("ok");
    if (!initial.conversation_id) throw new Error("conversation missing");

    const followup = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      { ...event, text: "Use @attachment:shared-brief" },
    );
    expect(followup.status).toBe("ok");

    const messages = await ctx.testDb.db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, initial.conversation_id));
    expect(messages.map((message) => (message.content as { text?: unknown }).text)).toContain(
      `Use [file:${toFileId(tenantFile.file_uuid)}]`,
    );

    const [link] = await ctx.testDb.db
      .select({ file_id: fileLinks.file_id })
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, initial.conversation_id),
          eq(fileLinks.slug, "shared-brief"),
        ),
      );
    expect(link?.file_id).toBe(tenantFile.file_uuid);
  });

  test("mention → approval → approve → read-only channel never commits", async () => {
    const ws = await ctx.testDb.db
      .insert(chatWorkspaces)
      .values({
        tenant_id: ctx.tenant_id,
        platform: "slack",
        workspace_id: "T123",
        bot_ciphertext: detBytes(1),
        bot_iv: detBytes(1),
        bot_auth_tag: detBytes(1),
      })
      .returning();
    expect(ws[0]).toBeTruthy();

    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      platform: "slack",
      workspace_id: "T123",
      platform_user_id: "U_ALICE",
    });

    const adapter = new FakeSlackAdapter();

    const mention: ChatEvent = {
      platform: "slack",
      workspace_id: "T123",
      channel_id: "C999",
      thread_id: "1700000000.000100",
      user_id: "U_ALICE",
      kind: "mention",
      text: "<@UBOT> list users",
      raw: {},
    };
    const initial = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention);
    expect(initial.status).toBe("ok");
    expect(initial.approval_sent).toBe(false);
    expect(adapter.approvals).toHaveLength(0);
    if (!initial.conversation_id) throw new Error("conversation missing");
    const [creationAudit] = await ctx.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "conversation.created"),
          eq(auditLog.resource_id, initial.conversation_id),
        ),
      );
    expect(creationAudit).toEqual({ actor_type: "user", actor_id: ctx.user_id });
    getMockProvider().setConversePlan(initial.conversation_id, [
      {
        tool: "ask_user_confirm",
        args: {
          question: "Confirm destructive test checkpoint?",
          kind: "generic",
          destructive: true,
        },
      },
      { tool: "save_workflow_draft", args: {} },
    ]);
    const r1 = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      { ...mention, text: "continue" },
    );
    expect(r1.status).toBe("ok");
    expect(r1.approval_sent).toBe(true);
    expect(adapter.approvals.length).toBe(1);
    const card = adapter.approvals[0];
    if (!card) throw new Error("no card");

    const pendingConversation = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, card.conversation_id))
      .limit(1);
    expect(pendingConversation[0]?.status).toBe("awaiting_input");
    expect(pendingConversation[0]?.origin_client).toBe("chat:slack");

    const interaction: ChatEvent = {
      platform: "slack",
      workspace_id: "T123",
      channel_id: "C999",
      ...(mention.thread_id ? { thread_id: mention.thread_id } : {}),
      user_id: "U_ALICE",
      kind: "interaction",
      interaction: { action_id: `approve:${card.approval_id}`, value: card.conversation_id },
      raw: {},
    };
    const r2 = await handleChatEvent({ db: ctx.testDb.db, adapter }, interaction);
    expect(r2.status).toBe("approved");

    const resumedConversation = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, card.conversation_id))
      .limit(1);
    expect(resumedConversation[0]?.status).not.toBe("committed");
    expect(resumedConversation[0]?.target_workflow_id).toBeNull();

    const toolCalls = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, card.conversation_id));
    const authoringCalls = toolCalls.filter((c) =>
      ["save_workflow_draft", "edit_workflow_patch", "author_workflow", "validate_draft"].includes(
        c.tool,
      ),
    );
    expect(authoringCalls).toEqual([]);
  });

  test("/subkit run <slug> routes through the conversation run contract", async () => {
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: "T_RUN",
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    });

    const [wf] = await ctx.testDb.db
      .insert(workflowsTable)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "ping-users",
        name: "Ping Users",
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error("seed workflow failed");
    const [ver] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: wf.id,
        version: 1,
        dag: {
          name: "Ping Users",
          steps: [
            {
              id: "noop",
              kind: "transform",
              expression: "$",
            },
          ],
        },
      })
      .returning();
    if (!ver) throw new Error("seed workflow version failed");
    await ctx.testDb.db
      .update(workflowsTable)
      .set({ current_version_id: ver.id })
      .where(eq(workflowsTable.id, wf.id));

    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      platform: "slack",
      workspace_id: "T_RUN",
      platform_user_id: "U_RUNNER",
    });

    const adapter = new FakeSlackAdapter();

    const helpOut = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      {
        platform: "slack",
        workspace_id: "T_RUN",
        channel_id: "C42",
        thread_id: "1700000001.000199",
        user_id: "U_RUNNER",
        kind: "slash_command",
        text: "/subkit run",
        raw: {},
      },
    );
    expect(helpOut.status).toBe("help");
    expect(adapter.sends[adapter.sends.length - 1]?.text).toContain("Usage");

    const ev: ChatEvent = {
      platform: "slack",
      workspace_id: "T_RUN",
      channel_id: "C42",
      thread_id: "1700000001.000200",
      user_id: "U_RUNNER",
      kind: "slash_command",
      text: "/subkit run ping-users",
      raw: {},
    };
    const out = await handleChatEvent({ db: ctx.testDb.db, adapter }, ev);
    expect(out.status).toBe("ok");
    expect(out.conversation_id).toBeTruthy();

    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.workflow_id, wf.id));
    expect(rows.length).toBe(1);

    const last = adapter.sends[adapter.sends.length - 1];
    expect(last?.text?.length ?? 0).toBeGreaterThan(0);

    const execsBefore = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.workflow_id, wf.id))
    ).length;
    const emptyOut = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      {
        platform: "slack",
        workspace_id: "T_RUN",
        channel_id: "C42",
        thread_id: "1700000001.000900",
        user_id: "U_RUNNER",
        kind: "mention",
        text: "<@UBOT>",
        raw: {},
      },
    );
    expect(emptyOut.status).toBe("help");
    const welcome = adapter.sends[adapter.sends.length - 1]?.text ?? "";
    expect(welcome).not.toContain("Usage");
    expect(welcome.toLowerCase()).toContain("run a saved workflow");
    expect(welcome).toContain("sk");
    expect(emptyOut.conversation_id).toBeUndefined();
    const execsAfter = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.workflow_id, wf.id))
    ).length;
    expect(execsAfter).toBe(execsBefore);
  });

  test("rejects an unknown chat user with a polite ephemeral; runs no turn", async () => {
    const [ws] = await ctx.testDb.db
      .insert(chatWorkspaces)
      .values({
        tenant_id: ctx.tenant_id,
        platform: "slack",
        workspace_id: "T_UNKNOWN",
        bot_ciphertext: detBytes(1),
        bot_iv: detBytes(1),
        bot_auth_tag: detBytes(1),
      })
      .returning();
    expect(ws).toBeTruthy();

    const adapter = new FakeSlackAdapter();
    const ev: ChatEvent = {
      platform: "slack",
      workspace_id: "T_UNKNOWN",
      channel_id: "C_X",
      user_id: "U_STRANGER",
      kind: "mention",
      text: "<@BOT> hi",
      raw: {},
    };
    const out = await handleChatEvent({ db: ctx.testDb.db, adapter }, ev);
    expect(out.status).toBe("ignored");
    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0]?.kind).toBe("ephemeral");
    expect(adapter.sends[0]?.text).toContain("isn't linked");
    expect(adapter.approvals.length).toBe(0);
    expect(out.conversation_id).toBeUndefined();
  });

  test("C-2: rejects an identity whose tenant_id doesn't match the workspace's tenant", async () => {
    const [ws] = await ctx.testDb.db
      .insert(chatWorkspaces)
      .values({
        tenant_id: ctx.tenant_id,
        platform: "slack",
        workspace_id: "T_C2",
        bot_ciphertext: detBytes(1),
        bot_iv: detBytes(1),
        bot_auth_tag: detBytes(1),
      })
      .returning();
    expect(ws).toBeTruthy();

    const { tenants: tenantsTbl, users: usersTbl } = await import("../../db/schema/index.ts");
    const [foreignTenant] = await ctx.testDb.db
      .insert(tenantsTbl)
      .values({ slug: "t-c2-foreign", display_name: "C2 Foreign" })
      .returning();
    if (!foreignTenant) throw new Error("seed foreign tenant");
    const [foreignUser] = await ctx.testDb.db
      .insert(usersTbl)
      .values({
        tenant_id: foreignTenant.id,
        email: "c2-foreign@test.local",
        role_id: await builtinRoleId(ctx.testDb.db, "admin"),
      })
      .returning();
    if (!foreignUser) throw new Error("seed foreign user");

    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: foreignTenant.id,
      user_id: foreignUser.id,
      platform: "slack",
      workspace_id: "T_C2",
      platform_user_id: "U_C2_VICTIM",
    });

    const adapter = new FakeSlackAdapter();
    const ev: ChatEvent = {
      platform: "slack",
      workspace_id: "T_C2",
      channel_id: "C_C2",
      user_id: "U_C2_VICTIM",
      kind: "mention",
      text: "<@BOT> hi",
      raw: {},
    };
    const out = await handleChatEvent({ db: ctx.testDb.db, adapter }, ev);

    expect(out.status).toBe("ignored");
    expect(out.conversation_id).toBeUndefined();
    expect(adapter.sends[0]?.kind).toBe("ephemeral");
    expect(adapter.sends[0]?.text).toContain("isn't linked");
  });

  test("/new clears chat_sessions for the thread and posts an ephemeral ack", async () => {
    const adapter = new FakeSlackAdapter();
    const ev: ChatEvent = {
      platform: "slack",
      workspace_id: "T123",
      channel_id: "C_RESET",
      thread_id: "1700000000.000999",
      user_id: "U_ALICE",
      kind: "slash_command",
      text: "/new",
      raw: {},
    };
    const out = await handleChatEvent({ db: ctx.testDb.db, adapter }, ev);
    expect(out.status).toBe("ok");
    expect(adapter.sends[adapter.sends.length - 1]?.kind).toBe("ephemeral");
    expect(adapter.sends[adapter.sends.length - 1]?.text).toMatch(/reset/i);
  });
});

describe("handleChatEvent replyDelivery:capture", () => {
  function mention(channel: string, text = "hello there"): ChatEvent {
    return {
      platform: "slack",
      workspace_id: "T123",
      channel_id: channel,
      user_id: "U_ALICE",
      kind: "mention",
      text: `<@UBOT> ${text}`,
      raw: {},
    };
  }

  test("capture returns reply_text and performs NO terminal send", async () => {
    const adapter = new FakeSlackAdapter();
    const out = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("C_CAPTURE_1"), {
      replyDelivery: "capture",
    });
    expect(out.status).toBe("ok");
    expect(out.approval_sent).toBe(false);
    expect(typeof out.reply_text).toBe("string");
    expect((out.reply_text ?? "").length).toBeGreaterThan(0);
    expect(adapter.sends.length).toBe(0);
  });

  test("default (send) mode is unchanged: sends the reply, reply_text null", async () => {
    const adapter = new FakeSlackAdapter();
    const out = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("C_CAPTURE_2"));
    expect(out.status).toBe("ok");
    expect(out.reply_text ?? null).toBeNull();
    expect(adapter.sends.length).toBeGreaterThanOrEqual(1);
    expect(adapter.sends[adapter.sends.length - 1]?.kind).toBe("message");
  });
});
