import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { createSubscription } from "../webhooks/outbound/service.ts";
import { EngineClient } from "./index.ts";

const deterministicUuid = createDeterministicUuidFactory(0x51b5c);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb("engine_client_subscription_actor");
});

afterAll(async () => {
  await testDb.cleanup();
});

test("EngineClient subscription update and delete retain user and service-account actors", async () => {
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "engine-client-subscription-actor", display_name: "Subscription actors" })
    .returning();
  if (!tenant) throw new Error("tenant insert returned no row");

  const create = (name: string) =>
    createSubscription(
      {
        tenant_id: tenant.id,
        actor_id: null,
        actor: null,
        event_pattern: `${name}.event`,
        target_url: "https://example.test/hook",
        secret: "fixture-secret",
      },
      testDb.db,
    );
  const userSubscription = await create("user");
  const accountSubscription = await create("account");
  const userId = deterministicUuid();
  const accountId = deterministicUuid();
  const userClient = new EngineClient({
    tenant_id: tenant.id,
    actor_id: userId,
    actor_type: "user",
    db: testDb.db,
  });
  const accountClient = new EngineClient({
    tenant_id: tenant.id,
    actor_id: accountId,
    actor_type: "system_account",
    db: testDb.db,
  });

  await userClient.subscriptions.update(userSubscription.id, { active: false });
  await accountClient.subscriptions.update(accountSubscription.id, { active: false });
  await userClient.subscriptions.delete(userSubscription.id);
  await accountClient.subscriptions.delete(accountSubscription.id);

  const rows = await testDb.db
    .select({
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      action: auditLog.action,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant.id),
        inArray(auditLog.resource_id, [userSubscription.id, accountSubscription.id]),
      ),
    );
  expect(rows).toEqual(
    expect.arrayContaining([
      { actor_type: "user", actor_id: userId, action: "subscription.updated" },
      { actor_type: "system_account", actor_id: accountId, action: "subscription.updated" },
      { actor_type: "user", actor_id: userId, action: "subscription.deleted" },
      { actor_type: "system_account", actor_id: accountId, action: "subscription.deleted" },
    ]),
  );
});
