import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { createSubscription } from "../service.ts";
import { createOutboundCtx, type OutboundTestCtx } from "./setup.ts";

const deterministicUuid = createDeterministicUuidFactory(0xbaad);

let ctx: OutboundTestCtx;

beforeAll(async () => {
  ctx = await createOutboundCtx("audit-actor");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("outbound subscription audit persists user, system account, and background actors", async () => {
  const userId = deterministicUuid();
  const accountId = deterministicUuid();
  const legacyId = deterministicUuid();
  const create = (
    actor_id: string | null,
    actor?: { kind: "user" | "system_account"; id: string },
  ) =>
    createSubscription(
      {
        tenant_id: ctx.tenantId,
        actor_id,
        ...(actor ? { actor } : {}),
        event_pattern: "fixture.event",
        target_url: "https://example.test/hook",
        secret: "fixture-secret",
      },
      ctx.db,
    );

  const user = await create(userId, { kind: "user", id: userId });
  const account = await create(accountId, { kind: "system_account", id: accountId });
  const legacy = await create(legacyId);
  const background = await create(null);
  const ids = [user.id, account.id, legacy.id, background.id];
  const rows = await ctx.db
    .select({
      resource_id: auditLog.resource_id,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "subscription.created")));
  expect(rows.filter((row) => ids.includes(row.resource_id ?? ""))).toEqual([
    { resource_id: user.id, actor_type: "user", actor_id: userId },
    { resource_id: account.id, actor_type: "system_account", actor_id: accountId },
    { resource_id: legacy.id, actor_type: "unknown", actor_id: null },
    { resource_id: background.id, actor_type: "system", actor_id: null },
  ]);
});
