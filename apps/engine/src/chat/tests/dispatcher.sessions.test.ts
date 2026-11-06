import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  chatIdentities,
  chatWorkspaces,
  conversationElicitations,
  users,
} from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { deliver, handleChatEvent } from "../dispatcher.ts";
import type { ChatEvent } from "../types.ts";
import { ctx, detBytes, FakeSlackAdapter, setupChatDispatcher } from "./dispatcher-fixtures.ts";

setupChatDispatcher();

describe("chat session mapping", () => {
  const WS = "T_MAP";
  let secondUserId: string;

  beforeAll(async () => {
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: WS,
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    });
    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      platform: "slack",
      workspace_id: WS,
      platform_user_id: "U_MAP1",
    });
    const [u2] = await ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: ctx.tenant_id,
        email: "second-mapper@example.com",
        role_id: await builtinRoleId(ctx.testDb.db, "member"),
      })
      .returning();
    if (!u2) throw new Error("seed second user failed");
    secondUserId = u2.id;
    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: secondUserId,
      platform: "slack",
      workspace_id: WS,
      platform_user_id: "U_MAP2",
    });
  });

  function mention(text: string, user = "U_MAP1", thread_id?: string): ChatEvent {
    return {
      platform: "slack",
      workspace_id: WS,
      channel_id: "C_MAP",
      ...(thread_id ? { thread_id } : {}),
      user_id: user,
      kind: "mention",
      text: `<@UBOT> ${text}`,
      raw: {},
    };
  }

  test("two top-level messages share the channel conversation; a thread reply gets its own", async () => {
    const adapter = new FakeSlackAdapter();
    const r1 = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("list workflows"));
    expect(r1.status).toBe("ok");
    expect(r1.conversation_id).toBeTruthy();

    const r2 = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("list executions"));
    expect(r2.conversation_id).toBe(r1.conversation_id);

    const r3 = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("list workflows", "U_MAP1", "1700000002.000300"),
    );
    expect(r3.conversation_id).toBeTruthy();
    expect(r3.conversation_id).not.toBe(r1.conversation_id);
  });

  test("a second linked user continues the SAME channel conversation under their own principal", async () => {
    const adapter = new FakeSlackAdapter();
    const before = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("list executions"),
    );
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("list workflows", "U_MAP2"),
    );
    expect(r.status).toBe("ok");
    expect(r.conversation_id).toBe(before.conversation_id);
  });

  test("/new resets the channel binding — the next message starts fresh", async () => {
    const adapter = new FakeSlackAdapter();
    const before = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("list workflows"));
    const reset = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      {
        platform: "slack",
        workspace_id: WS,
        channel_id: "C_MAP",
        user_id: "U_MAP1",
        kind: "slash_command",
        text: "/new",
        raw: {},
      },
    );
    expect(reset.status).toBe("ok");
    const after = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("list workflows"));
    expect(after.conversation_id).toBeTruthy();
    expect(after.conversation_id).not.toBe(before.conversation_id);
  });

  test("system removed_from_space drops the channel's session bindings", async () => {
    const adapter = new FakeSlackAdapter();
    const live = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("list workflows"));
    expect(live.conversation_id).toBeTruthy();

    const sys = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      {
        platform: "slack",
        workspace_id: WS,
        channel_id: "C_MAP",
        user_id: "",
        kind: "system",
        system_event: "removed_from_space",
        raw: {},
      },
    );
    expect(sys.status).toBe("ignored");

    const after = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("list workflows"));
    expect(after.conversation_id).not.toBe(live.conversation_id);
  });

  test("sendTracked formats CommonMark to the platform dialect before adapter.send", async () => {
    const adapter = new FakeSlackAdapter();
    await deliver(adapter, {
      tenant_id: ctx.tenant_id,
      workspace_id: "T123",
      channel_id: "C_FMT",
      kind: "message",
      text: "**Bold** and\n- a bullet\n• another\n[docs](https://x.io)",
    });
    expect(adapter.sends).toHaveLength(1);
    const sent = adapter.sends[0]?.text ?? "";
    expect(sent).toContain("*Bold*");
    expect(sent).not.toContain("**Bold**");
    expect(sent).toContain("* a bullet");
    expect(sent).toContain("* another");
    expect(sent).not.toContain("• another");
    expect(sent).toContain("<https://x.io|docs>");
  });

  test("an ignored (non-removed) system event logs its channel_id", async () => {
    const adapter = new FakeSlackAdapter();
    await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("list workflows"));

    const { logger } = await import("../../logging/logger.ts");
    const debugSpy = spyOn(logger, "debug");
    try {
      const sys = await handleChatEvent(
        { db: ctx.testDb.db, adapter },
        {
          platform: "slack",
          workspace_id: WS,
          channel_id: "C_IGNORED",
          user_id: "",
          kind: "system",
          system_event: "added_to_space",
          raw: {},
        },
      );
      expect(sys.status).toBe("ignored");
      const ignoredLog = debugSpy.mock.calls.find(
        (c) => (c[0] as { action?: string })?.action === "system_event.ignored",
      );
      expect(ignoredLog).toBeDefined();
      expect((ignoredLog?.[0] as { channel_id?: string })?.channel_id).toBe("C_IGNORED");
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe("typed reply while an elicitation is pending (salvage)", () => {
  const WS = "T_SALVAGE";
  const GUIDANCE_MARKER = "buttons or menu";
  let secondUserId: string;

  beforeAll(async () => {
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: WS,
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    });
    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      platform: "slack",
      workspace_id: WS,
      platform_user_id: "U_SALV_A",
    });
    const [u2] = await ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: ctx.tenant_id,
        email: "salvage-second@example.com",
        role_id: await builtinRoleId(ctx.testDb.db, "member"),
      })
      .returning();
    if (!u2) throw new Error("seed second salvage user failed");
    secondUserId = u2.id;
    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: secondUserId,
      platform: "slack",
      workspace_id: WS,
      platform_user_id: "U_SALV_B",
    });
  });

  function mention(channel: string, text: string, user = "U_SALV_A"): ChatEvent {
    return {
      platform: "slack",
      workspace_id: WS,
      channel_id: channel,
      user_id: user,
      kind: "mention",
      text: `<@UBOT> ${text}`,
      raw: {},
    };
  }

  async function seedConversation(channel: string): Promise<string> {
    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention(channel, "hello there"),
    );
    expect(r.status).toBe("ok");
    if (!r.conversation_id) throw new Error("seed conversation failed");
    return r.conversation_id;
  }

  async function seedPendingElicitation(
    conversation_id: string,
    tool_name: string,
    input: Record<string, unknown>,
    summary = "Input required",
  ): Promise<string> {
    const [row] = await ctx.testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name,
        summary,
        input,
        status: "pending",
      })
      .returning();
    if (!row) throw new Error("seed elicitation failed");
    return row.id;
  }

  async function readElicitation(id: string) {
    const [row] = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, id))
      .limit(1);
    if (!row) throw new Error("elicitation row disappeared");
    return row;
  }

  test("pending ask_user_text + typed reply resolves with { text } and posts no guidance", async () => {
    const conversationId = await seedConversation("C_SALV_TEXT");
    const elicitationId = await seedPendingElicitation(conversationId, "ask_user_text", {
      prompt: "Which city?",
    });

    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("C_SALV_TEXT", "Berlin"),
    );
    expect(r.status).toBe("ok");
    expect(r.conversation_id).toBe(conversationId);

    const row = await readElicitation(elicitationId);
    expect(row.status).toBe("resolved");
    expect(row.output).toEqual({ text: "Berlin" });
    expect(row.decided_by).toBe(ctx.user_id);
    expect(row.decided_by_kind).toBe("user");

    expect(adapter.sends.some((d) => d.text?.includes(GUIDANCE_MARKER))).toBe(false);
    expect(adapter.sends.length).toBeGreaterThan(0);
  });

  test("pending single-field ask_user_form + typed reply resolves with { [field.name]: text }", async () => {
    const conversationId = await seedConversation("C_SALV_FORM1");
    const elicitationId = await seedPendingElicitation(conversationId, "ask_user_form", {
      fields: [{ name: "email", type: "text", label: "Email" }],
    });

    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("C_SALV_FORM1", "ada@example.com"),
    );
    expect(r.status).toBe("ok");

    const row = await readElicitation(elicitationId);
    expect(row.status).toBe("resolved");
    expect(row.output).toEqual({ email: "ada@example.com" });
    expect(adapter.sends.some((d) => d.text?.includes(GUIDANCE_MARKER))).toBe(false);
  });

  test("pending ask_user_confirm + typed reply posts ONE guidance message and stays pending", async () => {
    const conversationId = await seedConversation("C_SALV_CONFIRM");
    const elicitationId = await seedPendingElicitation(conversationId, "ask_user_confirm", {
      question: "Proceed?",
    });

    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("C_SALV_CONFIRM", "sounds good, go ahead"),
    );
    expect(r.status).toBe("ok");
    expect(r.conversation_id).toBe(conversationId);

    const guidance = adapter.sends.filter((d) => d.text?.includes(GUIDANCE_MARKER));
    expect(guidance.length).toBe(1);
    expect(guidance[0]?.text).toContain("/new");
    expect(adapter.sends.length).toBe(1);

    const row = await readElicitation(elicitationId);
    expect(row.status).toBe("pending");
    expect(row.output).toBeNull();
  });

  test("pending multi-field ask_user_form + typed reply posts guidance and stays pending", async () => {
    const conversationId = await seedConversation("C_SALV_FORM2");
    const elicitationId = await seedPendingElicitation(conversationId, "ask_user_form", {
      fields: [
        { name: "city", type: "text", label: "City" },
        { name: "country", type: "text", label: "Country" },
      ],
    });

    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("C_SALV_FORM2", "Berlin Germany"),
    );
    expect(r.status).toBe("ok");

    const guidance = adapter.sends.filter((d) => d.text?.includes(GUIDANCE_MARKER));
    expect(guidance.length).toBe(1);

    const row = await readElicitation(elicitationId);
    expect(row.status).toBe("pending");
  });

  test("actor mismatch: a second linked user's typed reply is denied, audited, dialog stays pending", async () => {
    const conversationId = await seedConversation("C_SALV_ACTOR");
    const elicitationId = await seedPendingElicitation(conversationId, "ask_user_text", {
      prompt: "Which city?",
    });

    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("C_SALV_ACTOR", "Hamburg", "U_SALV_B"),
    );
    expect(r.status).toBe("ok");

    const guidance = adapter.sends.filter((d) => d.text?.includes("Only the person who started"));
    expect(guidance.length).toBe(1);
    expect(guidance[0]?.text).toContain("/new");

    const row = await readElicitation(elicitationId);
    expect(row.status).toBe("pending");
    expect(row.output).toBeNull();

    const denials = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "chat.message.denied"),
          eq(auditLog.reason, "actor_not_owner"),
          eq(auditLog.resource_id, elicitationId),
        ),
      );
    expect(denials.length).toBe(1);
    expect(denials[0]?.actor_id).toBe(secondUserId);
    expect(denials[0]?.result).toBe("denied");
  });

  test("validation failure re-prompts in-channel and leaves the row pending (re-answerable)", async () => {
    const conversationId = await seedConversation("C_SALV_VALID");
    const elicitationId = await seedPendingElicitation(conversationId, "ask_user_text", {
      prompt: "How many seats?",
      validation_regex: "^\\d+$",
    });

    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("C_SALV_VALID", "a few"),
    );
    expect(r.status).toBe("ok");

    const reprompts = adapter.sends.filter((d) => d.text?.includes("didn't pass validation"));
    expect(reprompts.length).toBe(1);

    const row = await readElicitation(elicitationId);
    expect(row.status).toBe("pending");
    expect(row.output).toBeNull();
  });
});
