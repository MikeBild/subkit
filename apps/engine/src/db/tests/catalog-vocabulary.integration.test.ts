import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { CatalogVocabularyBusyError, lockCatalogVocabulary } from "../catalog-vocabulary.ts";
import { tenants } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "./setup.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  ctx = await createTestDb("catalog_vocabulary");
  const rows = await ctx.db
    .insert(tenants)
    .values([
      { slug: "cv-a", display_name: "A" },
      { slug: "cv-b", display_name: "B" },
    ])
    .returning({ id: tenants.id });
  tenantA = rows[0]?.id ?? "";
  tenantB = rows[1]?.id ?? "";
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

function holdLock(tenant_id: string, ms: number) {
  const acquired = Promise.withResolvers<void>();
  const done = ctx.db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenant_id);
    acquired.resolve();
    await tx.execute(sql`SELECT pg_sleep(${ms / 1000})`);
  });
  return { acquired: acquired.promise, done };
}

describe("lockCatalogVocabulary", () => {
  test("a write waits for a briefly held lock and then proceeds", async () => {
    const holder = holdLock(tenantA, 300);
    await holder.acquired;
    const order: string[] = [];
    const writer = ctx.db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, tenantA);
      order.push("writer");
    });
    await holder.done;
    order.push("holder");
    await writer;
    expect(order).toEqual(["holder", "writer"]);
  });

  test("a lock held past the wait bound fails as busy", async () => {
    const holder = holdLock(tenantA, 400);
    await holder.acquired;
    await expect(
      ctx.db.transaction((tx) => lockCatalogVocabulary(tx, tenantA, 50)),
    ).rejects.toBeInstanceOf(CatalogVocabularyBusyError);
    await holder.done;
  });

  test("another tenant's lock never blocks", async () => {
    const holder = holdLock(tenantA, 400);
    await holder.acquired;
    await ctx.db.transaction((tx) => lockCatalogVocabulary(tx, tenantB, 50));
    await holder.done;
  });

  test("the caller's own lock timeout is restored after the wait", async () => {
    const timeout = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('lock_timeout', '7s', true)`);
      await lockCatalogVocabulary(tx, tenantA);
      const result = await tx.execute<{ lock_timeout: string }>(
        sql`SELECT current_setting('lock_timeout') AS lock_timeout`,
      );
      return result.rows[0]?.lock_timeout;
    });
    expect(timeout).toBe("7s");
  });
});
