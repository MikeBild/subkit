import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tenants } from "../db/schema/identity.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import type { AttentionClass, AttentionItem, AttentionReason } from "../operator/attention.ts";
import type { Candidate } from "../operator/attention-readers.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  type CockpitPushFixture,
  createCockpitPushFixtures,
  recordingPushSender,
} from "../tests/cockpit-push-fixture.ts";
import { dispatchCockpitPushAttention } from "./cockpit-push-attention.ts";

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
) {
  await dispatchCockpitPushAttention(ctx.db, fixture.tenantId, {
    now: at,
    subject: SUBJECT,
    attention: async () => ({ items }),
    send: send.send,
  });
  return send.sent.filter((endpoint) => endpoint === fixture.endpoint).length;
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

  test("stores only hashed attention keys", async () => {
    await dispatch(fixture, [conversation, authority]);
    const keys = await fixtures.storedKeys(fixture);
    expect(keys).toHaveLength(2);
    for (const key of keys ?? []) expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keys)).not.toContain("conv-1");
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
