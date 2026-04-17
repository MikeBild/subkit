// End-to-end dispatcher test:
//
//   Slack mention event → createConversation + runTurn
//   → canned "list users" plan raises an approval
//   → dispatcher sends an approval card (fake adapter records it)
//   → dispatcher receives an "approve" interaction
//   → decideApproval drives the plan to commit_draft
//   → conversation ends up status = 'committed'

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import {
  chatWorkspaces,
  conversations,
  executions,
  workflows as workflowsTable,
  workflowVersions,
} from "../../db/schema/index.ts";
import type { ChatAdapter } from "../adapter.ts";
import { type DispatchRunEnqueue, handleChatEvent } from "../dispatcher.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";

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
  test("mention → approval → approve → committed", async () => {
    // Seed a chat_workspaces row pointing at our test tenant.
    const ws = await ctx.testDb.db
      .insert(chatWorkspaces)
      .values({
        tenant_id: ctx.tenant_id,
        platform: "slack",
        workspace_id: "T123",
        bot_ciphertext: randomBytes(1),
        bot_iv: randomBytes(1),
        bot_auth_tag: randomBytes(1),
      })
      .returning();
    expect(ws[0]).toBeTruthy();

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

    const conv2 = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, card.conversation_id))
      .limit(1);
    expect(conv2[0]?.status).toBe("committed");
    expect(conv2[0]?.target_workflow_id).toBeTruthy();
  });

  test("/subkit run <slug> creates execution + invokes enqueueRun", async () => {
    // Seed a chat_workspaces row for a separate Slack workspace.
    await ctx.testDb.db.insert(chatWorkspaces).values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: "T_RUN",
      bot_ciphertext: randomBytes(1),
      bot_iv: randomBytes(1),
      bot_auth_tag: randomBytes(1),
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

    const adapter = new FakeSlackAdapter();
    const captured: DispatchRunEnqueue[] = [];

    const ev: ChatEvent = {
      platform: "slack",
      workspace_id: "T_RUN",
      channel_id: "C42",
      thread_id: "1700000001.000200",
      user_id: "U_RUNNER",
      kind: "slash_command",
      text: "/subkit run ping-users target=alice limit=5",
      raw: {},
    };
    const out = await handleChatEvent(
      {
        db: ctx.testDb.db,
        adapter,
        enqueueRun: async (job) => {
          captured.push(job);
        },
      },
      ev,
    );
    expect(out.status).toBe("ok");
    expect(out.execution_id).toBeTruthy();
    expect(out.workflow_id).toBe(wf.id);
    expect(captured.length).toBe(1);
    expect(captured[0]?.input).toEqual({ target: "alice", limit: "5" });
    expect(captured[0]?.workflow_id).toBe(wf.id);

    // Persistence: an executions row exists for the captured id.
    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.id, out.execution_id ?? ""));
    expect(rows.length).toBe(1);
    expect(rows[0]?.request_source).toBe("chat");

    // The dispatcher should have posted an ephemeral confirmation.
    const last = adapter.sends[adapter.sends.length - 1];
    expect(last?.kind).toBe("ephemeral");
    expect(last?.text).toContain("execution started");
  });
});
