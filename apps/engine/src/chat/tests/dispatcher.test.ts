// End-to-end dispatcher test:
//
//   Slack mention event → createConversation + runTurn on the CHAT
//   surface (channel-scoped read-only palette)
//   → canned "list users" authoring plan tries its authoring tools —
//     none are in the chat palette, so nothing drafts or commits
//   → the plan's ask_user_confirm still raises an approval card
//   → the approve interaction resumes the turn — ALSO on the chat
//     surface, so the resumed save_workflow_draft stays unavailable
//   → conversation never commits: authoring from a chat channel is
//     structurally impossible, even though the linked user has rights

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import {
  chatIdentities,
  chatWorkspaces,
  conversations,
  conversationToolCalls,
  executions,
  users,
  workflows as workflowsTable,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import type { ChatAdapter } from "../adapter.ts";
import { handleChatEvent } from "../dispatcher.ts";
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
    const r1 = await handleChatEvent({ db: ctx.testDb.db, adapter }, mention);
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
});
