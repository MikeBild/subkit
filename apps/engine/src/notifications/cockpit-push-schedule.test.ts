import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { tenants } from "../db/schema/identity.ts";
import { type NotificationSchedulePreference, userSetupPreferences } from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { buildAttention } from "../operator/attention.ts";
import type { Candidate } from "../operator/attention-readers.ts";
import type { AttentionItem } from "../operator/core/attention.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  type CockpitPushFixture,
  createCockpitPushFixtures,
  recordingPushSender,
} from "../tests/cockpit-push-fixture.ts";
import { dispatchCockpitPushAttention } from "./cockpit-push-attention.ts";

const SUBJECT = "https://subkit.example";
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
let ctx: HttpTestServer;
let at: Date;
let fixtures: ReturnType<typeof createCockpitPushFixtures>;
const nextUuid = createDeterministicUuidFactory(0xa88e);

function clock(offsetMinutes: number): string {
  const moved = new Date(at.getTime() + offsetMinutes * 60_000);
  return `${String(moved.getUTCHours()).padStart(2, "0")}:${String(moved.getUTCMinutes()).padStart(2, "0")}`;
}

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: null,
    reason: "failing",
    trigger: null,
    cause_class: null,
    counts: {},
    since: null,
    deadline: null,
    detail: null,
    actions: [],
    ...overrides,
  };
}

const failing = item("wf-fail");
const noted = item("wf-note", { reason: "patch_proposed", class: "decide" });
const stopped = item("wf-stop", {
  class: "stopped",
  severity: "critical",
  reason: "schedule_auto_paused",
  subject: { kind: "workflow", id: "w1", name: "Nightly", environment: "prod" },
});
const stoppedTest = item("wf-stop-test", {
  class: "stopped",
  severity: "critical",
  reason: "execution_authority_unavailable",
  subject: { kind: "workflow", id: "w2", name: "Nightly test", environment: "dev" },
});
const approval = item("wf-approve", {
  class: "decide",
  reason: "version_awaiting_approval",
  actions: [
    { verb: "review", href: "/cockpit/workflows/w1", primary: true, permission: "workflow:read" },
  ],
});

async function tenant(timezone = "UTC"): Promise<string> {
  const [row] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-push-quiet-${nextUuid()}`, display_name: "Quiet", timezone })
    .returning();
  if (!row) throw new Error("tenant fixture missing");
  await fixtures.prepareKey(row.id);
  return row.id;
}

async function prefer(
  fixture: CockpitPushFixture,
  values: {
    schedule?: NotificationSchedulePreference;
    timezone?: string | null;
    critical?: boolean;
    last_digest_at?: Date | null;
    approver?: string | null;
  },
) {
  const set = {
    ...(values.schedule !== undefined ? { notification_schedule: values.schedule } : {}),
    ...(values.timezone !== undefined ? { timezone: values.timezone } : {}),
    ...(values.critical !== undefined ? { critical_breakthrough: values.critical } : {}),
    ...(values.last_digest_at !== undefined ? { last_digest_at: values.last_digest_at } : {}),
    ...(values.approver !== undefined
      ? values.approver === null
        ? {
            approver_kind: "self" as const,
            approver_email: null,
            approver_user_id: null,
          }
        : {
            approver_kind: "teammate" as const,
            approver_email: "approver@example.test",
            approver_user_id: values.approver,
          }
      : {}),
  };
  await ctx.db
    .insert(userSetupPreferences)
    .values({ tenant_id: fixture.tenantId, user_id: fixture.userId, ...set })
    .onConflictDoUpdate({
      target: [userSetupPreferences.tenant_id, userSetupPreferences.user_id],
      set,
    });
}

async function pass(
  tenantId: string,
  itemsOf: (principal: ResolvedPrincipal) => AttentionItem[],
): Promise<string[]> {
  const sender = recordingPushSender();
  await dispatchCockpitPushAttention(ctx.db, tenantId, {
    now: at,
    subject: SUBJECT,
    attention: async (principal) => ({ items: itemsOf(principal) }),
    send: sender.send,
  });
  return sender.sent;
}

async function passPayloads(
  tenantId: string,
  itemsOf: (principal: ResolvedPrincipal) => AttentionItem[],
): Promise<Record<string, unknown>[]> {
  const payloads: Record<string, unknown>[] = [];
  const send = async (_subscription: unknown, payload: unknown) => {
    payloads.push(JSON.parse(String(payload)) as Record<string, unknown>);
    return {} as never;
  };
  await dispatchCockpitPushAttention(ctx.db, tenantId, {
    now: at,
    subject: SUBJECT,
    attention: async (principal) => ({ items: itemsOf(principal) }),
    send: send as never,
  });
  return payloads;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("cockpit-push-schedule");
  at = new Date(getTestNow());
  fixtures = createCockpitPushFixtures({ db: ctx.db, at, nextUuid });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the person's notification schedule decides when a push goes out", () => {
  test("outside working hours nothing is pushed, the start of the window delivers one summary", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, {
      schedule: { mode: "working_hours", from: clock(120), to: clock(240), days: EVERY_DAY },
    });
    expect(await pass(tenantId, () => [failing])).toEqual([]);
    expect(await pass(tenantId, () => [failing, noted])).toEqual([]);
    expect(await fixtures.storedKeys(person)).toBeNull();
    await prefer(person, {
      schedule: { mode: "working_hours", from: clock(-60), to: clock(60), days: EVERY_DAY },
    });
    const released = await passPayloads(tenantId, () => [failing, noted]);
    expect(released).toHaveLength(1);
    expect(released[0]?.summary).toEqual({ total: 2, by_class: { failing: 1, decide: 1 } });
    expect(await fixtures.storedKeys(person)).toHaveLength(2);
    expect(await pass(tenantId, () => [failing, noted])).toEqual([]);
    const later = await passPayloads(tenantId, () => [failing, noted, stopped, stoppedTest]);
    expect(later).toHaveLength(1);
    expect(later[0]?.summary).toBeUndefined();
  });

  test("the person's own time zone decides, the workspace zone is the fallback", async () => {
    const offset = at.getUTCHours() < 12 ? "Etc/GMT-10" : "Etc/GMT+10";
    const tenantId = await tenant(offset);
    const local = await fixtures.installation(tenantId);
    const remote = await fixtures.installation(tenantId);
    const schedule = {
      mode: "working_hours" as const,
      from: clock(-60),
      to: clock(60),
    };
    await prefer(local, { schedule, timezone: "UTC" });
    await prefer(remote, { schedule });
    const sent = await pass(tenantId, () => [failing]);
    expect(sent).toEqual([local.endpoint]);
    await prefer(remote, { timezone: "Mars/Olympus" });
    expect(await pass(tenantId, () => [failing])).toEqual([]);
  });

  test("a critical item breaks through only for a person who opted in", async () => {
    const tenantId = await tenant();
    const quiet = await fixtures.installation(tenantId);
    const onCall = await fixtures.installation(tenantId);
    const schedule = {
      mode: "working_hours" as const,
      from: clock(120),
      to: clock(240),
      days: EVERY_DAY,
    };
    await prefer(quiet, { schedule });
    await prefer(onCall, { schedule, critical: true });
    expect(await pass(tenantId, () => [failing, stoppedTest])).toEqual([]);
    expect(await pass(tenantId, () => [failing, stopped, stoppedTest])).toEqual([onCall.endpoint]);
    expect(await fixtures.storedKeys(onCall)).toHaveLength(1);
    expect(await fixtures.storedKeys(quiet)).toBeNull();
    expect(await pass(tenantId, () => [failing, stopped])).toEqual([]);
    expect(await pass(tenantId, () => [failing, noted])).toEqual([]);
    const open = {
      mode: "working_hours" as const,
      from: clock(-60),
      to: clock(60),
      days: EVERY_DAY,
    };
    await prefer(quiet, { schedule: open });
    await prefer(onCall, { schedule: open });
    const sent = await pass(tenantId, () => [failing, stopped]);
    expect(sent.sort()).toEqual([onCall.endpoint, quiet.endpoint].sort());
    expect(await fixtures.storedKeys(onCall)).toHaveLength(2);
  });

  test("the daily summary goes out once at its time and holds what comes later", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    const earlier = new Date(at.getTime() - 60 * 60_000);
    await prefer(person, {
      schedule: { mode: "daily_digest", at: clock(60) },
      last_digest_at: earlier,
    });
    expect(await pass(tenantId, () => [failing])).toEqual([]);
    await prefer(person, {
      schedule: { mode: "daily_digest", at: clock(-1) },
      last_digest_at: earlier,
    });
    expect(await pass(tenantId, () => [failing, noted])).toEqual([person.endpoint]);
    const [stored] = await ctx.db
      .select({ last_digest_at: userSetupPreferences.last_digest_at })
      .from(userSetupPreferences)
      .where(eq(userSetupPreferences.user_id, person.userId));
    expect(stored?.last_digest_at?.toISOString()).toBe(at.toISOString());
    expect(await pass(tenantId, () => [failing, noted, stopped])).toEqual([]);
  });

  test("the daily summary is one push that counts what waits and opens the newest item", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, {
      schedule: { mode: "daily_digest", at: clock(-1) },
      last_digest_at: new Date(at.getTime() - 24 * 60 * 60_000),
    });
    const newest = item("wf-newest", {
      class: "decide",
      reason: "patch_proposed",
      since: new Date(at.getTime() - 60_000).toISOString(),
      actions: [
        {
          verb: "review",
          href: "/cockpit/workflows/w9",
          primary: true,
          permission: "workflow:read",
        },
      ],
    });
    const older = { ...failing, since: new Date(at.getTime() - 3_600_000).toISOString() };
    const payloads = await passPayloads(tenantId, () => [older, newest, noted]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      type: "attention",
      items: [
        { id: "wf-newest", class: "decide", severity: "urgent", href: "/cockpit/workflows/w9" },
      ],
      more: 2,
      summary: { total: 3, by_class: { failing: 1, decide: 2 } },
    });
    expect(await passPayloads(tenantId, () => [older, newest, noted, stopped])).toEqual([]);
  });

  test("an empty summary still closes the day", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, {
      schedule: { mode: "daily_digest", at: clock(-1) },
      last_digest_at: new Date(at.getTime() - 24 * 60 * 60_000),
    });
    expect(await pass(tenantId, () => [])).toEqual([]);
    expect(await pass(tenantId, () => [failing])).toEqual([]);
  });
});

describe("approvals go to the person who approves", () => {
  test("the requester is not woken, the approver is, and only with the right to act", async () => {
    const tenantId = await tenant();
    const requester = await fixtures.installation(tenantId, { role: "member" });
    const approver = await fixtures.installation(tenantId, { role: "admin" });
    const bystander = await fixtures.installation(tenantId, { role: "admin" });
    await prefer(requester, { approver: approver.userId });
    const itemsOf = (principal: ResolvedPrincipal) =>
      principal.id === requester.userId ? [approval, failing] : [];
    const sent = await pass(tenantId, itemsOf);
    expect(sent.sort()).toEqual([approver.endpoint, requester.endpoint].sort());
    expect(await fixtures.storedKeys(requester)).toHaveLength(1);
    expect(await fixtures.storedKeys(approver)).toHaveLength(1);
    expect(sent).not.toContain(bystander.endpoint);
    expect(await pass(tenantId, itemsOf)).toEqual([]);
  });

  test("without the permission to act the approver is not woken and the requester keeps the notification", async () => {
    const tenantId = await tenant();
    const requester = await fixtures.installation(tenantId, { role: "admin" });
    const approver = await fixtures.installation(tenantId, { role: "member" });
    const own = await fixtures.installation(tenantId, { role: "admin" });
    await prefer(requester, { approver: approver.userId });
    await prefer(own, { approver: null });
    const guarded = {
      ...approval,
      actions: [{ ...approval.actions[0], permission: "rbac:write" }],
    } as AttentionItem;
    const sent = await pass(tenantId, (principal) =>
      principal.id === approver.userId ? [] : [guarded],
    );
    expect(sent.sort()).toEqual([own.endpoint, requester.endpoint].sort());
  });

  test("the requester's attention list says whom the item waits for", async () => {
    const tenantId = await tenant();
    const requester = await fixtures.installation(tenantId, { role: "admin" });
    const approver = await fixtures.installation(tenantId, { role: "admin" });
    const principal: ResolvedPrincipal = {
      provider: "test",
      kind: "user",
      id: requester.userId,
      tenant_id: tenantId,
      roles: ["admin"],
    };
    const readers = {
      budget: async (): Promise<Candidate[]> => [
        { item: approval, source: "budget" },
        { item: failing, source: "budget" },
      ],
    };
    const before = await buildAttention(ctx.db, principal, { now: at, readers });
    expect(before.items.every((entry) => entry.waiting_on === undefined)).toBe(true);
    await prefer(requester, { approver: approver.userId });
    const after = await buildAttention(ctx.db, principal, { now: at, readers });
    const waiting = after.items.find((entry) => entry.id === approval.id);
    expect(waiting?.waiting_on?.user_id).toBe(approver.userId);
    expect(waiting?.waiting_on?.name.length).toBeGreaterThan(0);
    expect(after.items.find((entry) => entry.id === failing.id)?.waiting_on).toBeUndefined();
  });

  test("an approver who cannot approve is not named, the item stays the requester's decision", async () => {
    const tenantId = await tenant();
    const requester = await fixtures.installation(tenantId, { role: "admin" });
    const approver = await fixtures.installation(tenantId, { role: "member" });
    await prefer(requester, { approver: approver.userId });
    const principal: ResolvedPrincipal = {
      provider: "test",
      kind: "user",
      id: requester.userId,
      tenant_id: tenantId,
      roles: ["admin"],
    };
    const guarded = {
      ...approval,
      id: "wf-approve-guarded",
      actions: [{ ...approval.actions[0], permission: "rbac:write" }],
    } as AttentionItem;
    const readers = {
      budget: async (): Promise<Candidate[]> => [
        { item: guarded, source: "budget" },
        { item: approval, source: "budget" },
      ],
    };
    const attention = await buildAttention(ctx.db, principal, { now: at, readers });
    const own = attention.items.find((entry) => entry.id === guarded.id);
    expect(own?.waiting_on).toBeUndefined();
    expect(own?.actions[0]?.verb).toBe("review");
    expect(attention.items.find((entry) => entry.id === approval.id)?.waiting_on?.user_id).toBe(
      approver.userId,
    );
  });
});
