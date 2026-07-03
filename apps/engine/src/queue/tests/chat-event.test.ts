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
//
// The second describe block covers the handler's unknown-workspace
// branch: DM auto-registration denials keep their precise audit
// reason, and user-initiated events (mention / slash / added_to_space)
// earn ONE rate-limited generic fallback reply via
// `chatRegistry.getFallback` — stale interactions and membership
// removals stay silent, and a failing fallback send never fails the
// job.

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

// ---------------------------------------------------------------------------
// Unknown-workspace branch: precise deny reasons + the rate-limited
// generic fallback reply. Google Chat's fallback is the ONE app-level
// adapter (service-account outbound), so a reply CAN land in an
// uninstalled space — unlike Slack, whose workspace-scoped tokens make
// the same send fail (also covered: the failure is swallowed).
// ---------------------------------------------------------------------------

class RecordingGoogleFallback {
  readonly platform: ChatPlatform = "google_chat";
  sends: ChatDelivery[] = [];
  failNext = false;
  async send(d: ChatDelivery) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("google api: 403 app not installed");
    }
    this.sends.push(d);
    return { platform_message_id: `gfb-${this.sends.length}` };
  }
}

const FALLBACK_TEXT =
  "This space isn't connected to sk yet. Ask an admin to install the sk app here to start using it.";

let googleFallback: RecordingGoogleFallback;

/** Poll until `count` deny audits exist for the given native workspace id. */
async function waitForDenyAudits(
  workspaceIdNative: string,
  count: number,
): Promise<Array<typeof auditLog.$inferSelect>> {
  // allow-wall-clock: real-time polling for queue completion
  const deadline = Date.now() + 60_000;
  let matches: Array<typeof auditLog.$inferSelect> = [];
  while (Date.now() < deadline) {
    const rows = await testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "chat.message.denied"));
    matches = rows.filter(
      (r) =>
        (r.metadata as Record<string, unknown> | null)?.workspace_id_native === workspaceIdNative,
    );
    if (matches.length >= count) return matches;
    await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: poll cadence
  }
  return matches;
}

function googleEvent(overrides: Partial<ChatEvent>): ChatEvent {
  return {
    platform: "google_chat",
    workspace_id: "spaces/UNSET",
    channel_id: "spaces/UNSET",
    user_id: "users/g-stranger",
    kind: "mention",
    text: "hello?",
    raw: {},
    ...overrides,
  };
}

describe("queue: chat.event unregistered-space fallback reply", () => {
  beforeAll(() => {
    googleFallback = new RecordingGoogleFallback();
    registry.registerFallback("google_chat", googleFallback);
  });

  test("mention in unknown space → deny audit + ONE generic reply; second mention rate-limited", async () => {
    const SPACE = "spaces/FB_MENTION";
    const ev1 = googleEvent({
      workspace_id: SPACE,
      channel_id: SPACE,
      thread_id: `${SPACE}/threads/T1`,
      event_key: "g-fb-m-1",
    });
    await boss.send(CHAT_EVENT_QUEUE, { event: ev1 });
    const firstDeny = await waitForDenyAudits(SPACE, 1);
    expect(firstDeny).toHaveLength(1);
    expect(firstDeny[0]?.tenant_id).toBe(SYSTEM_TENANT_ID);
    // Non-DM google event: the auto-registration gate denies as
    // not_dm_autoregistrable, which the handler records as the legacy
    // workspace_not_installed reason.
    expect(firstDeny[0]?.reason).toBe("workspace_not_installed");

    // The reply lands after the audit — poll the adapter directly.
    // allow-wall-clock: real-time polling for the outbound send
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && googleFallback.sends.length === 0) {
      await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: poll cadence
    }
    const local = googleFallback.sends.filter((d) => d.channel_id === SPACE);
    expect(local).toHaveLength(1);
    expect(local[0]?.kind).toBe("message");
    expect(local[0]?.text).toBe(FALLBACK_TEXT);
    // No tenant is known — the delivery carries only the system tenant
    // and reveals nothing about any real tenant.
    expect(local[0]?.tenant_id).toBe(SYSTEM_TENANT_ID);
    expect(local[0]?.thread_id).toBe(`${SPACE}/threads/T1`);

    // Second mention into the SAME space within the minute: deny audit
    // still recorded, but the 1/min/space bucket gates the reply.
    const ev2 = googleEvent({ workspace_id: SPACE, channel_id: SPACE, event_key: "g-fb-m-2" });
    await boss.send(CHAT_EVENT_QUEUE, { event: ev2 });
    const bothDenies = await waitForDenyAudits(SPACE, 2);
    expect(bothDenies).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 500)); // allow-wall-clock: settle for a (wrong) second send
    expect(googleFallback.sends.filter((d) => d.channel_id === SPACE)).toHaveLength(1);
  }, 90_000);

  test("added_to_space in unknown space → one generic reply", async () => {
    const SPACE = "spaces/FB_ADDED";
    const ev = googleEvent({
      workspace_id: SPACE,
      channel_id: SPACE,
      kind: "system",
      system_event: "added_to_space",
      event_key: "g-fb-a-1",
    });
    delete ev.text;
    await boss.send(CHAT_EVENT_QUEUE, { event: ev });
    await waitForDenyAudits(SPACE, 1);
    // allow-wall-clock: real-time polling for the outbound send
    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      googleFallback.sends.filter((d) => d.channel_id === SPACE).length === 0
    ) {
      await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: poll cadence
    }
    const local = googleFallback.sends.filter((d) => d.channel_id === SPACE);
    expect(local).toHaveLength(1);
    expect(local[0]?.text).toBe(FALLBACK_TEXT);
  }, 90_000);

  test("stale interaction + removed_from_space stay silent (deny audit only)", async () => {
    const SPACE_I = "spaces/FB_SILENT_I";
    const SPACE_R = "spaces/FB_SILENT_R";
    await boss.send(CHAT_EVENT_QUEUE, {
      event: googleEvent({
        workspace_id: SPACE_I,
        channel_id: SPACE_I,
        kind: "interaction",
        event_key: "g-fb-i-1",
      }),
    });
    await boss.send(CHAT_EVENT_QUEUE, {
      event: googleEvent({
        workspace_id: SPACE_R,
        channel_id: SPACE_R,
        kind: "system",
        system_event: "removed_from_space",
        event_key: "g-fb-r-1",
      }),
    });
    expect(await waitForDenyAudits(SPACE_I, 1)).toHaveLength(1);
    expect(await waitForDenyAudits(SPACE_R, 1)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 500)); // allow-wall-clock: settle for a (wrong) send
    expect(googleFallback.sends.filter((d) => d.channel_id === SPACE_I)).toHaveLength(0);
    expect(googleFallback.sends.filter((d) => d.channel_id === SPACE_R)).toHaveLength(0);
  }, 90_000);

  test("fallback send failure is swallowed — deny audit intact, job completes without retry", async () => {
    const SPACE = "spaces/FB_THROW";
    googleFallback.failNext = true;
    await boss.send(CHAT_EVENT_QUEUE, {
      event: googleEvent({ workspace_id: SPACE, channel_id: SPACE, event_key: "g-fb-t-1" }),
    });
    const denies = await waitForDenyAudits(SPACE, 1);
    expect(denies).toHaveLength(1);
    // The throw is caught inside the handler: no rethrow means pg-boss
    // never retries, so no second deny audit appears and no send lands.
    await new Promise((r) => setTimeout(r, 2_000)); // allow-wall-clock: settle for a (wrong) retry
    expect(await waitForDenyAudits(SPACE, 1)).toHaveLength(1);
    expect(googleFallback.sends.filter((d) => d.channel_id === SPACE)).toHaveLength(0);
    expect(googleFallback.failNext).toBe(false);
  }, 90_000);

  test("unlinked google DM keeps its precise deny reason (dm_sender_not_linked)", async () => {
    const SPACE = "spaces/FB_DM_UNLINKED";
    await boss.send(CHAT_EVENT_QUEUE, {
      event: googleEvent({
        workspace_id: SPACE,
        channel_id: SPACE,
        is_direct_message: true,
        user_id: "users/g-never-linked",
        event_key: "g-fb-dm-1",
      }),
    });
    const denies = await waitForDenyAudits(SPACE, 1);
    expect(denies).toHaveLength(1);
    expect(denies[0]?.reason).toBe("dm_sender_not_linked");
    expect(denies[0]?.tenant_id).toBe(SYSTEM_TENANT_ID);
    // No workspace row was provisioned for the denied DM.
    const rows = await testDb.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, SPACE));
    expect(rows).toHaveLength(0);
  }, 90_000);
});
