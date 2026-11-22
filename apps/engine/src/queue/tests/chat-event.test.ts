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
import { chatEventsSeen, chatIdentities, chatWorkspaces, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
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
let previousLlmProvider: string | undefined;

beforeAll(async () => {
  previousLlmProvider = testEnv.LLM_PROVIDER;
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  testDb = await createTestDb("chat-event-handler");
  const tenant = await seedTenant(testDb.db, { slug: "t-ce", display_name: "ChatEvent" });
  tenantId = tenant.id;
  const [user] = await testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "ce@test.local",
      role_id: await builtinRoleId(testDb.db, "admin"),
    })
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
  await disposeBoss(boss);
  await testDb.cleanup();
  resetMockProvider();
  if (previousLlmProvider === undefined) delete testEnv.LLM_PROVIDER;
  else testEnv.LLM_PROVIDER = previousLlmProvider;
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

    const job1: ChatEventJob = { event };
    const id1 = await boss.send(CHAT_EVENT_QUEUE, job1);
    expect(id1).toBeTruthy();

    const job2: ChatEventJob = { event };
    const id2 = await boss.send(CHAT_EVENT_QUEUE, job2);
    expect(id2).toBeTruthy();

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

    expect(adapter.sends.length - sendsBefore).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 500)); // allow-wall-clock: post-dedup settle
    const localSends = adapter.sends.filter((d) => d.channel_id === "C_QUEUE");
    expect(localSends.length).toBe(1);

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
    expect(denyRow?.tenant_id).toBe(SYSTEM_TENANT_ID);
  }, 90_000);
});

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
  "This space isn't connected to subkit yet. Ask an admin to install the subkit app here to start using it.";

let googleFallback: RecordingGoogleFallback;

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
    const firstMention = googleEvent({
      workspace_id: SPACE,
      channel_id: SPACE,
      thread_id: `${SPACE}/threads/T1`,
      event_key: "g-fb-m-1",
    });
    await boss.send(CHAT_EVENT_QUEUE, { event: firstMention });
    const firstDeny = await waitForDenyAudits(SPACE, 1);
    expect(firstDeny).toHaveLength(1);
    expect(firstDeny[0]?.tenant_id).toBe(SYSTEM_TENANT_ID);
    expect(firstDeny[0]?.reason).toBe("workspace_not_installed");

    // allow-wall-clock: real-time polling for the outbound send
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && googleFallback.sends.length === 0) {
      await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: poll cadence
    }
    const local = googleFallback.sends.filter((d) => d.channel_id === SPACE);
    expect(local).toHaveLength(1);
    expect(local[0]?.kind).toBe("message");
    expect(local[0]?.text).toBe(FALLBACK_TEXT);
    expect(local[0]?.tenant_id).toBe(SYSTEM_TENANT_ID);
    expect(local[0]?.thread_id).toBe(`${SPACE}/threads/T1`);

    const secondMention = googleEvent({
      workspace_id: SPACE,
      channel_id: SPACE,
      event_key: "g-fb-m-2",
    });
    await boss.send(CHAT_EVENT_QUEUE, { event: secondMention });
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
    const rows = await testDb.db
      .select()
      .from(chatWorkspaces)
      .where(eq(chatWorkspaces.workspace_id, SPACE));
    expect(rows).toHaveLength(0);
  }, 90_000);
});
