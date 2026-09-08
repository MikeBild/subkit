// End-to-end dispatcher test:
//
//   Slack mention event → createConversation + runTurn on the CHAT
//   surface (channel-scoped read-only palette)
//   → canned "list users" authoring plan tries its authoring tools —
//     none are in the chat palette, so nothing drafts or commits
//   → safe preparation produces no approval; an explicit destructive
//     checkpoint still raises an approval card
//   → the approve interaction resumes the turn — ALSO on the chat
//     surface, so the resumed save_workflow_draft stays unavailable
//   → conversation never commits: authoring from a chat channel is
//     structurally impossible, even though the linked user has rights

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import {
  auditLog,
  chatIdentities,
  chatWorkspaces,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  executions,
  users,
  workflows as workflowsTable,
  workflowVersions,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import type { ChatAdapter } from "../adapter.ts";
import { deliver, handleChatEvent } from "../dispatcher.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";

const nextHex = createDeterministicHexFactory(0xc4a7d15);
/** Deterministic stand-in for `randomBytes(n)` in tests — bytea
 *  columns just need *some* bytes; the deterministic-tests gate forbids
 *  Math.random / crypto.randomBytes so the test suite stays
 *  bit-for-bit reproducible. */
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

class FakeSlackAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  sends: ChatDelivery[] = [];
  approvals: ApprovalCard[] = [];
  async verify(): Promise<VerifiedEvent | null> {
    return null;
  }
  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    return ev as unknown as ChatEvent;
  }
  async send(d: ChatDelivery) {
    this.sends.push(d);
    return { platform_message_id: `msg-${this.sends.length}` };
  }
  async update(_d: ChatDelivery, _id: string) {}
  async sendApproval(c: ApprovalCard) {
    this.approvals.push(c);
    return { platform_message_id: `ap-${this.approvals.length}` };
  }
}

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("dispatcher");
});
afterAll(async () => {
  await ctx.cleanup();
});

describe("chat dispatcher", () => {
  test("mention → approval → approve → read-only channel never commits", async () => {
    // Seed a chat_workspaces row pointing at our test tenant.
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

    // The auto-link-to-admin shortcut is gone: the dispatcher rejects
    // unknown chat users. Pre-link the test user → the seeded subkit
    // user so the turn actually runs.
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

    const conv1 = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, card.conversation_id))
      .limit(1);
    expect(conv1[0]?.status).toBe("awaiting_input");

    // Simulate Slack interaction (click Approve) → dispatcher runs decideApproval.
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

    // Chat is a read-only channel: the resumed turn ran WITHOUT the
    // authoring palette, so the canned plan's save_workflow_draft never
    // fired — no commit, no workflow, even for a fully-linked user.
    const conv2 = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, card.conversation_id))
      .limit(1);
    expect(conv2[0]?.status).not.toBe("committed");
    expect(conv2[0]?.target_workflow_id).toBeNull();

    // Defense-in-depth check on the tool-call log: no authoring tool
    // ever executed in this conversation — the palette never carried
    // them, so the loop's wrapper never persisted a row for one.
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
    // Seed a chat_workspaces row for a separate Slack workspace.
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: "T_RUN",
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    });

    // Seed a workflow + version so the dispatcher can resolve it.
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

    // Pre-link runner — auto-link-to-admin is gone.
    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
      platform: "slack",
      workspace_id: "T_RUN",
      platform_user_id: "U_RUNNER",
    });

    const adapter = new FakeSlackAdapter();

    // Bare usage guard stays a dispatcher concern: no workflow named →
    // ephemeral usage text, no conversation created.
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

    // With a slug the verb is rewritten to a "run <slug>" prompt and
    // handed to the SAME conversation turn every other run takes —
    // the previous inline path skipped the confirm gate + input
    // contract (an execute_writes workflow ran unconfirmed from chat).
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

    // The run went through the conversation contract (fast-path:
    // RBAC gate → confirm policy → execute) — an executions row for
    // the seeded workflow exists.
    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.workflow_id, wf.id));
    expect(rows.length).toBe(1);

    // The dispatcher posted the turn's reply into the thread.
    const last = adapter.sends[adapter.sends.length - 1];
    expect(last?.text?.length ?? 0).toBeGreaterThan(0);

    // Empty / mention-only message → friendly welcome, no turn. A bare
    // mention (bot id, no ask) resolves to an empty prompt, so the
    // dispatcher greets the user and returns without running a turn.
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
    // Welcoming, actionable — no terse "Usage:" line, no emojis.
    const welcome = adapter.sends[adapter.sends.length - 1]?.text ?? "";
    expect(welcome).not.toContain("Usage");
    expect(welcome.toLowerCase()).toContain("run a saved workflow");
    expect(welcome).toContain("sk");
    // Help path threads no conversation and runs no turn — execution
    // count is unchanged and no conversation_id came back.
    expect(emptyOut.conversation_id).toBeUndefined();
    const execsAfter = (
      await ctx.testDb.db.select().from(executions).where(eq(executions.workflow_id, wf.id))
    ).length;
    expect(execsAfter).toBe(execsBefore);
  });

  // -------------------------------------------------------------------
  // Step 8 — explicit identity linking. Auto-link-to-admin is gone.
  // -------------------------------------------------------------------
  test("rejects an unknown chat user with a polite ephemeral; runs no turn", async () => {
    // Seed an installed workspace but DO NOT link any platform user.
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
    // No conversation was created.
    expect(out.conversation_id).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // /new reset — drops the chat_sessions row for the thread so the
  // next message starts a fresh `createConversation` turn.
  // -------------------------------------------------------------------
  test("C-2: rejects an identity whose tenant_id doesn't match the workspace's tenant", async () => {
    // Workspace is in our test tenant.
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

    // Seed an identity row whose tenant_id is some OTHER tenant, but
    // whose global (platform, workspace_id, platform_user_id) tuple
    // matches an event in our tenant's workspace. The
    // chat_identities.user_id FK is satisfied by reusing ctx.user_id
    // (any user in the foreign tenant would do — we only need a row
    // that the dispatcher's tuple-keyed lookup finds first).
    // To make this realistic, create a separate tenant + user and use
    // those IDs.
    const { tenants: tenantsTbl, users: usersTbl } = await import("../../db/schema/index.ts");
    const [foreignTenant] = await ctx.testDb.db
      .insert(tenantsTbl)
      .values({ slug: "t-c2-foreign", display_name: "C2 Foreign" })
      .returning();
    if (!foreignTenant) throw new Error("seed foreign tenant");
    const [foreignUser] = await ctx.testDb.db
      .insert(usersTbl)
      .values({ tenant_id: foreignTenant.id, email: "c2-foreign@test.local", role: "admin" })
      .returning();
    if (!foreignUser) throw new Error("seed foreign user");

    await ctx.testDb.db.insert(chatIdentities).values({
      tenant_id: foreignTenant.id, // mismatch — wrong tenant
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
    // The user sees the same "not linked" message; the audit log
    // distinguishes the reason via the metadata.
    expect(adapter.sends[0]?.kind).toBe("ephemeral");
    expect(adapter.sends[0]?.text).toContain("isn't linked");
  });

  test("/new clears chat_sessions for the thread and posts an ephemeral ack", async () => {
    // Re-use the workspace seeded by the first test (T123) and its
    // U_ALICE identity link.
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

// ── Session mapping: channel = persistent conversation ──────────────────────
//
// Top-level messages (no thread_id) bind to the `${channel}:root`
// session, so a space keeps ONE running conversation (topic memory);
// real thread replies get their own conversation; `/new` resets the
// binding; a second linked user joins the SAME channel conversation
// while each turn runs under the sender's own principal.

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
    // A second real user in the same tenant, linked to a second
    // platform identity.
    const [u2] = await ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: ctx.tenant_id,
        email: "second-mapper@example.com",
        role: "member",
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

    // The binding is gone: the next message opens a fresh conversation.
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
    // Register the workspace first so the event reaches the dispatcher's
    // system-event branch under a resolved tenant.
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

// ── Typed-reply salvage while an ask_user_* dialog is pending ────────────────
//
// A user who TYPES a plain message while an elicitation is still open
// used to kill the chat.event job (PendingElicitationBlockedError →
// pg-boss retry → dedup swallow → conversation hung until /new). The
// dispatcher now salvages the typed line:
//
//   ask_user_text          → resolves with { text: <typed> }
//   single-field form      → resolves with { [field.name]: <typed> }
//   confirm / multi-field  → one guidance message, dialog stays pending
//   wrong actor            → guidance + CHAT_MESSAGE_DENIED audit, pending
//   validation failure     → re-prompt notify, row stays pending

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
    // A second linked user in the same tenant for the actor-mismatch case.
    const [u2] = await ctx.testDb.db
      .insert(users)
      .values({
        tenant_id: ctx.tenant_id,
        email: "salvage-second@example.com",
        role: "member",
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

  /** Open a channel conversation via a benign mention (no canned plan
   *  matches "hello there", so the mock just acks and the turn ends). */
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

  /** Insert a pending elicitation row directly — same shape the loop's
   *  ask_user_* tools persist, minus the tool_call anchor (legacy rows
   *  lack it too; respondElicitation tolerates its absence). */
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

    // No guidance line — the typed answer WAS the resolution; the only
    // outbound message is the resumed turn's normal reply.
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
    // The guidance is the ONLY outbound send — no resumed-turn reply.
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
    // Conversation owned by user A (their mention created it).
    const conversationId = await seedConversation("C_SALV_ACTOR");
    const elicitationId = await seedPendingElicitation(conversationId, "ask_user_text", {
      prompt: "Which city?",
    });

    // User B types into the SAME channel conversation.
    const adapter = new FakeSlackAdapter();
    const r = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("C_SALV_ACTOR", "Hamburg", "U_SALV_B"),
    );
    expect(r.status).toBe("ok");

    // Guidance names the owner rule; the typed line resolved nothing.
    const guidance = adapter.sends.filter((d) => d.text?.includes("Only the person who started"));
    expect(guidance.length).toBe(1);
    expect(guidance[0]?.text).toContain("/new");

    const row = await readElicitation(elicitationId);
    expect(row.status).toBe("pending");
    expect(row.output).toBeNull();

    // The denial is audited with the shared actor_not_owner reason.
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

// ── F2 capture mode: dispatcher computes the terminal reply but the sync
// Google-Chat helper owns delivery, so capture mode must NOT send it. ────────
describe("handleChatEvent replyDelivery:capture", () => {
  // Re-uses the T123 workspace + U_ALICE identity seeded by the first test
  // in this file (same suite, sequential).
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
    // The terminal reply is captured, not sent.
    expect(typeof out.reply_text).toBe("string");
    expect((out.reply_text ?? "").length).toBeGreaterThan(0);
    expect(adapter.sends.length).toBe(0);
  });

  test("default (send) mode is unchanged: sends the reply, reply_text null", async () => {
    const adapter = new FakeSlackAdapter();
    const out = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention("C_CAPTURE_2"));
    expect(out.status).toBe("ok");
    // Capture field is only populated in capture mode.
    expect(out.reply_text ?? null).toBeNull();
    // The reply went out through the adapter exactly as before F2.
    expect(adapter.sends.length).toBeGreaterThanOrEqual(1);
    expect(adapter.sends[adapter.sends.length - 1]?.kind).toBe("message");
  });
});
