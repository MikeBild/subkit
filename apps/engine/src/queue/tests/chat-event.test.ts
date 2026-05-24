// End-to-end test for the chat.event queue handler.
//
// Validates the gap called out in the plan's Step 9 (Checkpoint 4) —
// "Queue: handler test for chat-event.ts (dedup + dispatch)". The
// handler's per-job logic is the only piece not covered elsewhere:
//
//   1. Resolve the chat_workspaces row from (platform, workspace_id).
//   2. Insert into chat_events_seen (dedup) — return early on replay.
//   3. Resolve the workspace-specific adapter from chatRegistry.
//   4. Invoke handleChatEvent.
//
// We enqueue two jobs with the SAME event_key (mirroring a Slack
// retry) and assert that exactly ONE dispatch reaches the registered
// adapter.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { SYSTEM_TENANT_ID } from "../../audit/types.ts";
import { ChatAdapterRegistry } from "../../chat/registry.ts";
import type {
  ApprovalCard,
  ChatDelivery,
  ChatEvent,
  ChatPlatform,
  VerifiedEvent,
} from "../../chat/types.ts";
import { auditLog } from "../../db/schema/audit.ts";
import {
  chatEventsSeen,
  chatIdentities,
  chatWorkspaces,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createBoss, disposeBoss } from "../boss.ts";
import { registerChatEventHandler } from "../handlers/chat-event.ts";
import { CHAT_EVENT_QUEUE, type ChatEventJob } from "../queues.ts";

const nextHex = createDeterministicHexFactory(0x4ace4e1);
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

class RecordingSlackAdapter {
  readonly platform: ChatPlatform = "slack";
  sends: ChatDelivery[] = [];
  async verify(): Promise<VerifiedEvent | null> {
    return null;
  }
  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    return ev as unknown as ChatEvent;
  }
  async send(d: ChatDelivery) {
    this.sends.push(d);
    return { platform_message_id: `m-${this.sends.length}` };
  }
  async update(_d: ChatDelivery, _id: string) {}
  async sendApproval(_c: ApprovalCard) {
    return { platform_message_id: "ap-1" };
  }
}

let testDb: TestDb;
let boss: PgBoss;
let tenantId: string;
let workspaceRowId: string;
let registry: ChatAdapterRegistry;
let adapter: RecordingSlackAdapter;

beforeAll(async () => {
  testDb = await createTestDb("chat-event-handler");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-ce", display_name: "ChatEvent" })
    .returning();
  if (!tenant) throw new Error("seed tenant");
  tenantId = tenant.id;
  const [user] = await testDb.db
    .insert(users)
    .values({ tenant_id: tenantId, email: "ce@test.local", role: "admin" })
    .returning();
  if (!user) throw new Error("seed user");

  const [ws] = await testDb.db
    .insert(chatWorkspaces)
    .values({
      tenant_id: tenantId,
      platform: "slack",
      workspace_id: "T_HANDLER",
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    })
    .returning();
  if (!ws) throw new Error("seed chat_workspaces");
  workspaceRowId = ws.id;

  // Link the platform user so the dispatcher doesn't reject as
  // "not linked". The handler routes the event through the full
  // dispatcher path, so the explicit-link contract still applies.
  await testDb.db.insert(chatIdentities).values({
    tenant_id: tenantId,
    user_id: user.id,
    platform: "slack",
    workspace_id: "T_HANDLER",
    platform_user_id: "U_HANDLER",
  });

  adapter = new RecordingSlackAdapter();
  registry = new ChatAdapterRegistry();
  registry.register(
    { tenant_id: tenantId, platform: "slack", workspace_id: "T_HANDLER" },
    adapter as unknown as Parameters<typeof registry.register>[1],
  );

  boss = await createBoss({ connectionString: testDb.url });
  await registerChatEventHandler({ boss, db: testDb.db, chatRegistry: registry });
});

afterAll(async () => {
  await disposeBoss(boss, 5_000);
  await testDb.cleanup();
});

describe("queue: chat.event worker", () => {
  test("dedup: two jobs with the same event_key dispatch only once", async () => {
    const event: ChatEvent = {
      platform: "slack",
      workspace_id: "T_HANDLER",
      channel_id: "C_QUEUE",
      thread_id: "1700000005.000100",
      user_id: "U_HANDLER",
      kind: "mention",
      text: "<@UBOT> say hi",
      event_key: "Ev_DEDUP_42",
      raw: {},
    };
    const sendsBefore = adapter.sends.length;

    // First job — should dedup-mark + dispatch.
    const job1: ChatEventJob = { event };
    const id1 = await boss.send(CHAT_EVENT_QUEUE, job1);
    expect(id1).toBeTruthy();

    // Second job — same event_key, should be dropped by dedup.
    const job2: ChatEventJob = { event };
    const id2 = await boss.send(CHAT_EVENT_QUEUE, job2);
    expect(id2).toBeTruthy();

    // Poll until the seen-row exists AND the dispatcher's outbound
    // send has fired exactly once. 60s budget for parallel-test load.
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const seen = await testDb.db
        .select()
        .from(chatEventsSeen)
        .where(eq(chatEventsSeen.platform_event_id, "Ev_DEDUP_42"));
      if (seen.length === 1 && adapter.sends.length > sendsBefore) break;
      await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: poll cadence
    }

    const seenRows = await testDb.db
      .select()
      .from(chatEventsSeen)
      .where(eq(chatEventsSeen.platform_event_id, "Ev_DEDUP_42"));
    expect(seenRows).toHaveLength(1);
    expect(seenRows[0]?.tenant_id).toBe(tenantId);
    expect(seenRows[0]?.workspace_id).toBe(workspaceRowId);

    // The dispatcher reaches `sendTracked` exactly once for the first
    // job (either the assistant reply, the "Working on it…" ack, or
    // the help text). The second job hits the dedup early-return and
    // never reaches sendTracked.
    expect(adapter.sends.length - sendsBefore).toBeGreaterThanOrEqual(1);
    // Wait a beat to give a (wrong) second dispatch a chance to land,
    // then assert it didn't.
    await new Promise((r) => setTimeout(r, 500)); // allow-wall-clock: post-dedup settle
    // Filter to sends originating from this test's channel so a parallel
    // suite using the same boss can't pollute the assertion.
    const localSends = adapter.sends.filter((d) => d.channel_id === "C_QUEUE");
    // Exactly one outbound regardless of how many jobs we enqueued.
    expect(localSends.length).toBe(1);

    // The dedup-drop branch writes a chat.message.denied audit row
    // with reason: "replay" so SIEM can see retries-against-a-known-
    // workspace traffic even though the worker drops them silently.
    // Poll because the second job's dedup-drop audit may land after
    // the seen-row poll above breaks.
    // allow-wall-clock: real-time poll for audit insert
    const replayDeadline = Date.now() + 30_000;
    let replayRow: typeof auditLog.$inferSelect | undefined;
    while (Date.now() < replayDeadline) {
      const replayAudits = await testDb.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "chat.message.denied"));
      replayRow = replayAudits.find(
        (r) =>
          r.reason === "replay" &&
          r.tenant_id === tenantId &&
          (r.metadata as Record<string, unknown> | null)?.event_key === "Ev_DEDUP_42",
      );
      if (replayRow) break;
      await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: poll cadence
    }
    expect(replayRow).toBeTruthy();
  }, 90_000);

  test("unknown workspace: drops job + writes SYSTEM_TENANT_ID denied audit", async () => {
    // Enqueue an event whose workspace_id has no chat_workspaces row.
    const event: ChatEvent = {
      platform: "slack",
      workspace_id: "T_NONEXISTENT",
      channel_id: "C_X",
      user_id: "U_X",
      kind: "mention",
      text: "<@BOT> hi",
      event_key: "Ev_UNKNOWN_WS",
      raw: {},
    };
    const id = await boss.send(CHAT_EVENT_QUEUE, { event });
    expect(id).toBeTruthy();

    // Poll until the worker writes the deny row.
    // allow-wall-clock: real-time polling for queue completion
    const deadline = Date.now() + 60_000;
    let denyRow: typeof auditLog.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const rows = await testDb.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "chat.message.denied"));
      denyRow = rows.find(
        (r) =>
          r.reason === "workspace_not_installed" &&
          (r.metadata as Record<string, unknown> | null)?.workspace_id_native === "T_NONEXISTENT",
      );
      if (denyRow) break;
      await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: poll cadence
    }
    expect(denyRow).toBeTruthy();
    // We don't know the owning tenant — record under SYSTEM_TENANT_ID.
    expect(denyRow?.tenant_id).toBe(SYSTEM_TENANT_ID);
  }, 90_000);
});
