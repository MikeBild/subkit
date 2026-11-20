import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { tenants } from "../db/schema/identity.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import type { CockpitPushAudienceRow } from "../identity/index.ts";
import { logger } from "../logging/logger.ts";
import type {
  AttentionClass,
  AttentionItem,
  AttentionReason,
  AttentionV1,
} from "../operator/attention.ts";
import type { Candidate } from "../operator/attention-readers.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  type CockpitPushFixture,
  createCockpitPushFixtures,
  recordingPushSender,
} from "../tests/cockpit-push-fixture.ts";
import {
  dedupeSameDeviceAudience,
  dispatchCockpitPushAttention,
} from "./cockpit-push-attention.ts";

const SUBJECT = "https://subkit.example";
let ctx: HttpTestServer;
let at: Date;
let fixtures: ReturnType<typeof createCockpitPushFixtures>;
const nextUuid = createDeterministicUuidFactory(0xa77e);

function item(id: string, attentionClass: AttentionClass, reason: AttentionReason): AttentionItem {
  return {
    id,
    class: attentionClass,
    severity: "urgent",
    kind: "workflow",
    subject: null,
    reason,
    trigger: null,
    cause_class: null,
    counts: {},
    since: null,
    deadline: null,
    detail: null,
    actions: [],
  };
}

const conversation = item("conv-1", "stopped", "awaiting_answer");
const authority = item("wf-1", "stopped", "execution_authority_required");
const failing = item("wf-2", "failing", "failing");

async function dispatch(
  fixture: CockpitPushFixture,
  items: AttentionItem[],
  send = recordingPushSender(),
  options: { sources?: Partial<AttentionV1["sources"]>; subject?: string | null } = {},
) {
  await dispatchCockpitPushAttention(ctx.db, fixture.tenantId, {
    now: at,
    subject: options.subject === undefined ? SUBJECT : options.subject,
    attention: async () => ({ items, ...(options.sources ? { sources: options.sources } : {}) }),
    send: send.send,
  });
  return send.sent.filter((endpoint) => endpoint === fixture.endpoint).length;
}

function rejectingPushSender(statusCode: number) {
  const sent: string[] = [];
  const send = async (subscription: { endpoint: string }) => {
    sent.push(subscription.endpoint);
    throw Object.assign(new Error("push service unavailable"), { statusCode });
  };
  return { sent, send: send as never };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("cockpit-push-attention");
  at = new Date(getTestNow());
  fixtures = createCockpitPushFixtures({ db: ctx.db, at, nextUuid });
  await fixtures.prepareKey(ctx.tenantId);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("attention-driven cockpit push", () => {
  let fixture: CockpitPushFixture;
  beforeEach(async () => {
    fixture = await fixtures.installation(ctx.tenantId);
  });

  test("notifies once per new or changed attention item", async () => {
    expect(await dispatch(fixture, [conversation, authority])).toBe(1);
    expect(await dispatch(fixture, [conversation, authority])).toBe(0);
    expect(await dispatch(fixture, [conversation, authority, failing])).toBe(1);
    expect(await dispatch(fixture, [conversation])).toBe(0);
    expect(await dispatch(fixture, [conversation, authority])).toBe(1);
    expect(await dispatch(fixture, [conversation, item("wf-1", "failing", "failing")])).toBe(1);
  });

  test("each task reason wakes the person once, and again only when it changes", async () => {
    const task = (reason: AttentionReason, attentionClass: AttentionClass): AttentionItem => ({
      ...item("task:44444444-5555-4666-8777-888888888888", attentionClass, reason),
      kind: "task",
    });
    const reasons = [
      task("task_run_failed", "failing"),
      task("task_grant_required", "decide"),
      task("task_result_ready", "decide"),
      task("task_grant_expiring", "decide"),
    ];
    for (const current of reasons) {
      expect(await dispatch(fixture, [current])).toBe(1);
      expect(await dispatch(fixture, [current])).toBe(0);
    }
  });

  test("stores only hashed attention keys", async () => {
    await dispatch(fixture, [conversation, authority]);
    const keys = await fixtures.storedKeys(fixture);
    expect(keys).toHaveLength(2);
    for (const key of keys ?? []) expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keys)).not.toContain("conv-1");
  });

  test("a failed attention source keeps its items notified until it recovers", async () => {
    expect(await dispatch(fixture, [conversation, authority])).toBe(1);
    expect(
      await dispatch(fixture, [conversation], recordingPushSender(), {
        sources: { conversations: "answered", schedules: "failed" },
      }),
    ).toBe(0);
    expect(await dispatch(fixture, [conversation, authority])).toBe(0);
    expect(
      await dispatch(fixture, [conversation, authority, failing], recordingPushSender(), {
        sources: { conversations: "failed" },
      }),
    ).toBe(1);
  });

  test("a rejected push is retried on the next pass", async () => {
    const rejected = rejectingPushSender(500);
    expect(await dispatch(fixture, [conversation], rejected)).toBe(1);
    expect(await fixtures.storedKeys(fixture)).toBeNull();
    expect(await dispatch(fixture, [conversation])).toBe(1);
    expect(await dispatch(fixture, [conversation])).toBe(0);
  });

  test("an unavailable push subject keeps the attention pending", async () => {
    expect(await dispatch(fixture, [conversation], recordingPushSender(), { subject: null })).toBe(
      0,
    );
    expect(await fixtures.storedKeys(fixture)).toBeNull();
    expect(await dispatch(fixture, [conversation])).toBe(1);
  });

  test("an empty attention list sends nothing", async () => {
    expect(await dispatch(fixture, [])).toBe(0);
  });

  test("parallel dispatches notify exactly once", async () => {
    const sender = recordingPushSender();
    await Promise.all([
      dispatch(fixture, [conversation], sender),
      dispatch(fixture, [conversation], sender),
    ]);
    expect(sender.sent.filter((endpoint) => endpoint === fixture.endpoint)).toHaveLength(1);
  });

  test("never selects another tenant's installation", async () => {
    const [other] = await ctx.db
      .insert(tenants)
      .values({ slug: `t-push-other-${nextUuid()}`, display_name: "Other push tenant" })
      .returning();
    if (!other) throw new Error("missing other tenant");
    await fixtures.prepareKey(other.id);
    const foreign = await fixtures.installation(other.id);
    const sender = recordingPushSender();
    await dispatchCockpitPushAttention(ctx.db, ctx.tenantId, {
      now: at,
      subject: SUBJECT,
      attention: async () => ({ items: [conversation] }),
      send: sender.send,
    });
    expect(sender.sent).not.toContain(foreign.endpoint);
    expect(sender.sent).toContain(fixture.endpoint);
  });
});

test("attention RBAC decides who is woken", async () => {
  const budgetItem = item("budget-1", "failing", "budget_critical");
  const readers = {
    budget: async (): Promise<Candidate[]> => [{ item: budgetItem, source: "budget" }],
  };
  const admin = await fixtures.installation(ctx.tenantId, { role: "admin" });
  const member = await fixtures.installation(ctx.tenantId, { role: "member" });
  const sender = recordingPushSender();
  await dispatchCockpitPushAttention(ctx.db, ctx.tenantId, {
    now: at,
    subject: SUBJECT,
    readers,
    send: sender.send,
  });
  expect(sender.sent).toContain(admin.endpoint);
  expect(sender.sent).not.toContain(member.endpoint);
});

describe("browser tab attention push", () => {
  function countingAttention(items: AttentionItem[]) {
    const principals: ResolvedPrincipal[] = [];
    return {
      principals,
      attention: async (principal: ResolvedPrincipal) => {
        principals.push(principal);
        return { items };
      },
    };
  }

  async function dispatchFor(tenantId: string, items: AttentionItem[]) {
    const sender = recordingPushSender();
    const built = countingAttention(items);
    await dispatchCockpitPushAttention(ctx.db, tenantId, {
      now: at,
      subject: SUBJECT,
      attention: built.attention,
      send: sender.send,
    });
    return { sent: sender.sent, principals: built.principals };
  }

  async function isolatedTenant() {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: `t-push-browser-${nextUuid()}`, display_name: "Browser push tenant" })
      .returning();
    if (!tenant) throw new Error("missing browser push tenant");
    await fixtures.prepareKey(tenant.id);
    return tenant.id;
  }

  test("a browser row is notified once per new attention item", async () => {
    const tenantId = await isolatedTenant();
    const browser = await fixtures.browser(tenantId);
    const first = await dispatchFor(tenantId, [conversation]);
    expect(first.sent).toEqual([browser.endpoint]);
    expect(first.principals.map((principal) => principal.installation_id)).toEqual([undefined]);
    expect(first.principals[0]).toMatchObject({
      kind: "user",
      id: browser.userId,
      tenant_id: tenantId,
    });
    expect((await dispatchFor(tenantId, [conversation])).sent).toEqual([]);
  });

  test("one attention build per user and one push per device", async () => {
    const tenantId = await isolatedTenant();
    const installed = await fixtures.installation(tenantId);
    const browser = await fixtures.browser(tenantId, { userId: installed.userId });
    await fixtures.onDevice(installed, "11111111-1111-4111-8111-111111111111");
    await fixtures.onDevice(browser, "22222222-2222-4222-8222-222222222222");
    const result = await dispatchFor(tenantId, [conversation]);
    expect(result.principals).toHaveLength(1);
    expect(result.sent.sort()).toEqual([installed.endpoint, browser.endpoint].sort());
  });

  test("the installed app wins on a shared device and the skip is logged", async () => {
    const tenantId = await isolatedTenant();
    const installed = await fixtures.installation(tenantId);
    const browser = await fixtures.browser(tenantId, {
      userId: installed.userId,
      device: "33333333-3333-4333-8333-333333333333",
    });
    await fixtures.onDevice(installed, "33333333-3333-4333-8333-333333333333");
    const info = spyOn(logger, "info");
    try {
      const result = await dispatchFor(tenantId, [conversation]);
      expect(result.sent).toEqual([installed.endpoint]);
      expect(await fixtures.storedKeys(browser)).toBeNull();
      const sent = info.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((fields) => fields.action === "cockpit_push.sent" && fields.tenant_id === tenantId);
      expect(sent).toEqual([
        expect.objectContaining({
          kind: "installation",
          installation_id: installed.installationId,
          skipped_same_device: 1,
        }),
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test("rows without a device hash are never treated as the same device", async () => {
    const tenantId = await isolatedTenant();
    const installed = await fixtures.installation(tenantId);
    const browser = await fixtures.browser(tenantId, { userId: installed.userId });
    const result = await dispatchFor(tenantId, [conversation]);
    expect(result.sent.sort()).toEqual([installed.endpoint, browser.endpoint].sort());
  });

  test("a failed browser send restores its claim", async () => {
    const tenantId = await isolatedTenant();
    const browser = await fixtures.browser(tenantId);
    const rejected = rejectingPushSender(500);
    await dispatchCockpitPushAttention(ctx.db, tenantId, {
      now: at,
      subject: SUBJECT,
      attention: async () => ({ items: [conversation] }),
      send: rejected.send,
    });
    expect(rejected.sent).toEqual([browser.endpoint]);
    expect(await fixtures.storedKeys(browser)).toBeNull();
    expect((await dispatchFor(tenantId, [conversation])).sent).toEqual([browser.endpoint]);
  });
});

describe("same-device dedupe", () => {
  const row = (
    id: string,
    kind: "installation" | "browser",
    userId: string,
    device: string | null,
  ): CockpitPushAudienceRow => ({
    id,
    kind,
    installation_id: kind === "installation" ? `inst-${id}` : null,
    user_id: userId,
    device_sha256: device,
    notified_attention_keys: null,
  });

  test("drops only browser rows that share a device with the same user's installation", () => {
    const rows = [
      row("b1", "browser", "u1", "d1"),
      row("i1", "installation", "u1", "d1"),
      row("b2", "browser", "u1", "d2"),
      row("b3", "browser", "u1", null),
      row("i2", "installation", "u1", null),
      row("b4", "browser", "u2", "d1"),
    ];
    const result = dedupeSameDeviceAudience(rows);
    expect(result.kept.map((kept) => kept.id)).toEqual(["i1", "b2", "b3", "i2", "b4"]);
    expect(result.skipped.map((skipped) => skipped.id)).toEqual(["b1"]);
    expect(dedupeSameDeviceAudience(rows)).toEqual(result);
    expect(dedupeSameDeviceAudience([])).toEqual({ kept: [], skipped: [] });
  });
});
