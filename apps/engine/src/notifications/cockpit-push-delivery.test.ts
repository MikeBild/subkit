import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import { tenants } from "../db/schema/identity.ts";
import { type NotificationSchedulePreference, userSetupPreferences } from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import type { AttentionItem } from "../operator/core/attention.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  type CockpitPushFixture,
  createCockpitPushFixtures,
} from "../tests/cockpit-push-fixture.ts";
import { AUTO_PAUSE_NOTICE_WINDOW_MS } from "./auto-pause-cap.ts";
import { dispatchCockpitPushAttention } from "./cockpit-push-attention.ts";

const SUBJECT = "https://subkit.example";
const BERLIN = "Europe/Berlin";
const FRIDAY_NOON = new Date("2026-11-20T11:00:00Z");
const FRIDAY_EVENING = new Date("2026-11-20T18:00:00Z");
const SATURDAY_NOON = new Date("2026-11-21T11:00:00Z");
const MONDAY_BEFORE = new Date("2026-11-23T07:59:00Z");
const MONDAY_START = new Date("2026-11-23T08:00:00Z");
const OFFICE = { mode: "working_hours" as const, from: "09:00", to: "17:00" };
const MINUTE = 60_000;

let ctx: HttpTestServer;
let fixtures: ReturnType<typeof createCockpitPushFixtures>;
const nextUuid = createDeterministicUuidFactory(0xa13e);

function item(name: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `workflow:${name}`,
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

function paused(id: string, environment: "dev" | "prod" = "prod"): AttentionItem {
  return item(id, {
    class: "stopped",
    reason: "schedule_auto_paused",
    subject: { kind: "workflow", id: `workflow:${id}`, name: id, environment },
  });
}

async function tenant(): Promise<string> {
  const [row] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-push-delivery-${nextUuid()}`, display_name: "Delivery", timezone: BERLIN })
    .returning();
  if (!row) throw new Error("tenant fixture missing");
  await fixtures.prepareKey(row.id);
  return row.id;
}

async function prefer(
  fixture: CockpitPushFixture,
  schedule: NotificationSchedulePreference,
  last_digest_at: Date | null = null,
): Promise<void> {
  const set = { notification_schedule: schedule, last_digest_at };
  await ctx.db
    .insert(userSetupPreferences)
    .values({ tenant_id: fixture.tenantId, user_id: fixture.userId, ...set })
    .onConflictDoUpdate({
      target: [userSetupPreferences.tenant_id, userSetupPreferences.user_id],
      set,
    });
}

interface Push {
  endpoint: string;
  payload: {
    items: { id: string }[];
    more: number;
    summary?: { schedules_paused?: number; total?: number; by_class?: Record<string, number> };
  };
}

function sender(behaviour: (endpoint: string) => Promise<void> = async () => {}) {
  const pushes: Push[] = [];
  const send = async (subscription: { endpoint: string }, payload: string) => {
    await behaviour(subscription.endpoint);
    pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    return {} as never;
  };
  return { pushes, send: send as never };
}

function engineProcess(
  tenantId: string,
  at: Date,
  items: AttentionItem[],
  send: ReturnType<typeof sender>["send"],
) {
  return dispatchCockpitPushAttention(ctx.db, tenantId, {
    now: at,
    subject: SUBJECT,
    attention: async () => ({ items }),
    send,
  });
}

async function digestMark(person: CockpitPushFixture): Promise<string | null> {
  const [row] = await ctx.db
    .select({ at: userSetupPreferences.last_digest_at })
    .from(userSetupPreferences)
    .where(
      and(
        eq(userSetupPreferences.tenant_id, person.tenantId),
        eq(userSetupPreferences.user_id, person.userId),
      ),
    );
  return row?.at?.toISOString() ?? null;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("cockpit-push-delivery");
  fixtures = createCockpitPushFixtures({ db: ctx.db, at: FRIDAY_NOON, nextUuid });
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("what was held is delivered once at the start of working hours", () => {
  test("the weekend holds, Monday morning delivers one summary", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, OFFICE);
    const friday = sender();
    await engineProcess(tenantId, FRIDAY_EVENING, [item("a")], friday.send);
    const saturday = sender();
    await engineProcess(tenantId, SATURDAY_NOON, [item("a"), item("b")], saturday.send);
    const early = sender();
    await engineProcess(tenantId, MONDAY_BEFORE, [item("a"), item("b"), item("c")], early.send);
    expect([...friday.pushes, ...saturday.pushes, ...early.pushes]).toEqual([]);
    expect(await fixtures.storedKeys(person)).toBeNull();

    const monday = sender();
    await engineProcess(tenantId, MONDAY_START, [item("a"), item("b"), item("c")], monday.send);
    expect(monday.pushes).toHaveLength(1);
    expect(monday.pushes[0]?.payload.summary?.total).toBe(3);
    expect(monday.pushes[0]?.payload.items).toHaveLength(1);
    expect(monday.pushes[0]?.payload.more).toBe(2);
    const again = sender();
    await engineProcess(tenantId, MONDAY_START, [item("a"), item("b"), item("c")], again.send);
    expect(again.pushes).toEqual([]);
  });

  test("a person who works on the weekend is reached on Saturday", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, { ...OFFICE, days: [6, 7] });
    const friday = sender();
    await engineProcess(tenantId, FRIDAY_NOON, [item("a")], friday.send);
    expect(friday.pushes).toEqual([]);
    const saturday = sender();
    await engineProcess(tenantId, SATURDAY_NOON, [item("a")], saturday.send);
    expect(saturday.pushes.map((push) => push.endpoint)).toEqual([person.endpoint]);
  });

  test("two engine processes racing at the start deliver the summary exactly once", async () => {
    const tenantId = await tenant();
    const people = [
      await fixtures.installation(tenantId),
      await fixtures.installation(tenantId),
      await fixtures.installation(tenantId),
    ];
    for (const person of people) await prefer(person, OFFICE);
    const held = sender();
    await engineProcess(tenantId, SATURDAY_NOON, [item("a"), item("b")], held.send);
    expect(held.pushes).toEqual([]);
    for (let round = 0; round < 5; round++) {
      const at = new Date(MONDAY_START.getTime() + round * MINUTE);
      const items = [item("a"), item("b"), item(`round-${round}`)];
      const first = sender();
      const second = sender();
      const third = sender();
      await Promise.all([
        engineProcess(tenantId, at, items, first.send),
        engineProcess(tenantId, at, items, second.send),
        engineProcess(tenantId, at, items, third.send),
      ]);
      const sent = [...first.pushes, ...second.pushes, ...third.pushes];
      expect(sent.map((push) => push.endpoint).sort()).toEqual(
        people.map((person) => person.endpoint).sort(),
      );
      for (const push of sent) {
        const ids = push.payload.items.map((entry) => entry.id.replace("workflow:", "")).sort();
        expect(ids).toEqual(round === 0 ? ["a"] : [`round-${round}`]);
        expect(push.payload.summary?.total).toBe(round === 0 ? 3 : undefined);
      }
    }
  });

  test("a process that starts after a restart delivers what the stopped one held", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, OFFICE);
    const before = sender();
    await engineProcess(tenantId, FRIDAY_EVENING, [item("a")], before.send);
    expect(before.pushes).toEqual([]);
    const late = new Date(MONDAY_START.getTime() + 3 * 60 * MINUTE);
    const after = sender();
    await engineProcess(tenantId, late, [item("a")], after.send);
    expect(after.pushes.map((push) => push.endpoint)).toEqual([person.endpoint]);
  });
});

describe("the daily summary across engine processes", () => {
  const DIGEST = { mode: "daily_digest" as const, at: "09:00" };
  const YESTERDAY = new Date("2026-11-19T08:00:00Z");
  const DUE = new Date("2026-11-20T08:00:30Z");

  test("two processes racing at the summary time send it once and close the day once", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, DIGEST, YESTERDAY);
    const first = sender();
    const second = sender();
    await Promise.all([
      engineProcess(tenantId, DUE, [item("a"), item("b")], first.send),
      engineProcess(tenantId, DUE, [item("a"), item("b")], second.send),
    ]);
    expect([...first.pushes, ...second.pushes]).toHaveLength(1);
    expect(await digestMark(person)).toBe(DUE.toISOString());
    const later = sender();
    await engineProcess(tenantId, new Date(DUE.getTime() + MINUTE), [item("c")], later.send);
    expect(later.pushes).toEqual([]);
  });

  test("a summary whose delivery failed in one process is not closed by the other", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, DIGEST, YESTERDAY);
    let release: () => void = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const claimed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const failing = sender(async () => {
      entered();
      await sending;
      throw new Error("push service unavailable");
    });
    const losing = sender();
    const first = engineProcess(tenantId, DUE, [item("a")], failing.send);
    await claimed;
    await engineProcess(tenantId, DUE, [item("a")], losing.send);
    expect(losing.pushes).toEqual([]);
    expect(await digestMark(person)).toBe(DUE.toISOString());
    release();
    await first;
    expect(failing.pushes).toEqual([]);
    expect(await digestMark(person)).toBe(YESTERDAY.toISOString());
    expect(await fixtures.storedKeys(person)).toBeNull();

    const retry = sender();
    const next = new Date(DUE.getTime() + MINUTE);
    await engineProcess(tenantId, next, [item("a")], retry.send);
    expect(retry.pushes.map((push) => push.endpoint)).toEqual([person.endpoint]);
    expect(await digestMark(person)).toBe(next.toISOString());
  });

  test("a summary time missed while the engine was down is delivered on the next sweep", async () => {
    const tenantId = await tenant();
    const person = await fixtures.installation(tenantId);
    await prefer(person, DIGEST, YESTERDAY);
    const late = new Date("2026-11-20T15:00:00Z");
    const afterRestart = sender();
    await engineProcess(tenantId, late, [item("a")], afterRestart.send);
    expect(afterRestart.pushes).toHaveLength(1);
    expect(await digestMark(person)).toBe(late.toISOString());
  });
});

describe("paused schedules reach a person at most once an hour", () => {
  test("further pauses within the hour wait and arrive as one summary", async () => {
    const tenantId = await tenant();
    await fixtures.installation(tenantId);
    const start = FRIDAY_NOON;
    const first = sender();
    await engineProcess(tenantId, start, [paused("p1")], first.send);
    expect(first.pushes).toHaveLength(1);
    expect(first.pushes[0]?.payload.summary).toBeUndefined();

    const within = sender();
    const soon = new Date(start.getTime() + 10 * MINUTE);
    await engineProcess(tenantId, soon, [paused("p1"), paused("p2"), item("f1")], within.send);
    expect(within.pushes).toHaveLength(1);
    expect(
      within.pushes[0]?.payload.items.map((entry) => entry.id.replace("workflow:", "")),
    ).toEqual(["f1"]);

    const still = sender();
    const later = new Date(start.getTime() + 50 * MINUTE);
    const all = [paused("p1"), paused("p2"), paused("p3"), paused("p4", "dev"), item("f1")];
    await engineProcess(tenantId, later, all, still.send);
    expect(still.pushes).toEqual([]);

    const summary = sender();
    const afterHour = new Date(start.getTime() + AUTO_PAUSE_NOTICE_WINDOW_MS + MINUTE);
    await engineProcess(tenantId, afterHour, all, summary.send);
    expect(summary.pushes).toHaveLength(1);
    expect(summary.pushes[0]?.payload.summary).toEqual({ schedules_paused: 3 });
    expect(
      summary.pushes[0]?.payload.items.map((entry) => entry.id.replace("workflow:", "")).sort(),
    ).toEqual(["p2", "p3", "p4"]);

    const capped = sender();
    const nextPause = new Date(afterHour.getTime() + 5 * MINUTE);
    await engineProcess(tenantId, nextPause, [...all, paused("p5")], capped.send);
    expect(capped.pushes).toEqual([]);
  });

  test("a rollout that pauses many schedules at once sends one notification per person", async () => {
    const tenantId = await tenant();
    const one = await fixtures.installation(tenantId);
    const two = await fixtures.installation(tenantId);
    const many = Array.from({ length: 12 }, (_, index) => paused(`w${index}`));
    const burst = sender();
    await Promise.all([
      engineProcess(tenantId, FRIDAY_NOON, many, burst.send),
      engineProcess(tenantId, FRIDAY_NOON, many, burst.send),
    ]);
    expect(burst.pushes.map((push) => push.endpoint).sort()).toEqual(
      [one.endpoint, two.endpoint].sort(),
    );
    for (const push of burst.pushes) {
      expect(push.payload.summary).toEqual({ schedules_paused: 12 });
      expect(push.payload.items.length + push.payload.more).toBe(12);
    }
    const [row] = await ctx.db
      .select({ at: cockpitPushSubscriptions.auto_pause_notified_at })
      .from(cockpitPushSubscriptions)
      .where(eq(cockpitPushSubscriptions.id, one.subscriptionId));
    expect(row?.at?.toISOString()).toBe(FRIDAY_NOON.toISOString());
  });
});
