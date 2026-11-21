import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { users } from "../../db/schema/identity.ts";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
} from "../../http/tests/setup.ts";
import {
  COCKPIT_PUSH_ATTENTION_CADENCE_MS,
  SchedulerReconciler,
} from "../../scheduler/reconciler.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createCockpitPushFixtures } from "../../tests/cockpit-push-fixture.ts";
import { runCockpitPushAttention } from "./cockpit-push-attention-runner.ts";

let ctx: HttpTestServer;
let at: Date;
const nextUuid = createDeterministicUuidFactory(0x5eed);

beforeAll(async () => {
  ctx = await createHttpTestServer("cockpit-push-runner");
  at = new Date(getTestNow());
});

afterAll(async () => {
  await ctx.cleanup();
});

test("dispatches once per tenant with a live push audience", async () => {
  const fixtures = createCockpitPushFixtures({ db: ctx.db, at, nextUuid });
  const stale = await createSecondaryTenant(ctx, "push-stale");
  await fixtures.installation(ctx.tenantId);
  await fixtures.installation(ctx.tenantId);
  const staleFixture = await fixtures.installation(stale.tenantId);
  await ctx.db
    .update(users)
    .set({ status: "disabled" })
    .where(and(eq(users.tenant_id, stale.tenantId), eq(users.id, staleFixture.userId)));
  const dispatched: string[] = [];
  const visited = await runCockpitPushAttention(ctx.db, at, async (_db, tenantId) => {
    dispatched.push(tenantId);
    return { notified: 0, delivered: 0 };
  });
  expect(dispatched).toEqual([ctx.tenantId]);
  expect(visited).toEqual([ctx.tenantId]);
});

test("pages through every tenant with a live push audience in one pass", async () => {
  const fixtures = createCockpitPushFixtures({ db: ctx.db, at, nextUuid });
  const first = await createSecondaryTenant(ctx, "push-page-first");
  const second = await createSecondaryTenant(ctx, "push-page-second");
  await fixtures.installation(first.tenantId);
  await fixtures.installation(second.tenantId);
  const expected = [ctx.tenantId, first.tenantId, second.tenantId].sort();
  const dispatched: string[] = [];
  const visited = await runCockpitPushAttention(
    ctx.db,
    at,
    async (_db, tenantId) => {
      dispatched.push(tenantId);
      return { notified: 0, delivered: 0 };
    },
    1,
  );
  expect(dispatched).toEqual(expected);
  expect(visited).toEqual(expected);
});

test("the reconciler respects the attention cadence", async () => {
  const passes: Date[] = [];
  const reconciler = new SchedulerReconciler({
    boss: {} as PgBoss,
    db: ctx.db,
    intervalMs: 60_000,
    cockpitPushAttentionRunner: async (_db, passAt) => {
      passes.push(passAt);
      return [];
    },
  });
  await reconciler.reconcileCockpitPushAttention(at);
  await reconciler.reconcileCockpitPushAttention(new Date(at.getTime() + 30_000));
  await reconciler.reconcileCockpitPushAttention(
    new Date(at.getTime() + COCKPIT_PUSH_ATTENTION_CADENCE_MS),
  );
  expect(passes.map((pass) => pass.getTime() - at.getTime())).toEqual([
    0,
    COCKPIT_PUSH_ATTENTION_CADENCE_MS,
  ]);
});
