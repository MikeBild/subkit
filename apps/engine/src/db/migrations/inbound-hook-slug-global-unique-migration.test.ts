import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";

test(
  "an inbound hook slug is unique across all tenants",
  async () => {
    const ctx = await createTestDb("inbound_slug_global_unique");
    try {
      const indexes = await ctx.db.execute<{ indexname: string; indexdef: string }>(sql`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'webhooks_inbound' AND schemaname = current_schema()
           AND indexname <> 'webhooks_inbound_pkey'
      `);
      expect(indexes.rows.map((r) => r.indexname)).toEqual(["webhooks_inbound_slug_key"]);
      expect(indexes.rows[0]?.indexdef).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(slug\)$/);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
