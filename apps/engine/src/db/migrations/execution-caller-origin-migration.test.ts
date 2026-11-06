import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";

test(
  "an execution without caller origin keeps its caller context and reads as unknown",
  async () => {
    const ctx = await createTestDb("execution_caller_origin");
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"execution-caller-origin"}, ${"Execution caller origin"}) RETURNING id
  `);
      if (!tenant) throw new Error("test tenant missing");
      const caller = {
        tenantId: tenant.id,
        principalId: "00000000-0000-4000-8000-000000000042",
        principalKind: "user",
        provider: "test",
        productId: null,
      };
      for (const [requestSource, context] of [
        ["api", caller],
        ["scheduler", null],
        ["webhook", null],
        ["mcp", { ...caller, tenantId: caller.principalId }],
      ] as const) {
        await ctx.pool.query(
          `INSERT INTO executions
          (tenant_id, status, request_source, execution_mode, caller_context)
         VALUES ($1, 'queued', $2, 'dev', $3::jsonb)`,
          [tenant.id, requestSource, context === null ? null : JSON.stringify(context)],
        );
      }
      const before = await ctx.pool.query(
        "SELECT id, caller_context FROM executions WHERE tenant_id = $1 ORDER BY id",
        [tenant.id],
      );
      const after = await ctx.pool.query(
        "SELECT id, caller_context, caller_origin FROM executions WHERE tenant_id = $1 ORDER BY id",
        [tenant.id],
      );
      expect(after.rows).toEqual(before.rows.map((row) => ({ ...row, caller_origin: "unknown" })));
      const inserted = await ctx.pool.query<{ caller_origin: string }>(
        `INSERT INTO executions (tenant_id, status, request_source, execution_mode)
       VALUES ($1, 'queued', 'scheduler', 'dev') RETURNING caller_origin`,
        [tenant.id],
      );
      expect(inserted.rows).toEqual([{ caller_origin: "unknown" }]);
      expect(
        (
          await ctx.pool.query(
            "SELECT id, caller_context, caller_origin FROM executions WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id",
            [tenant.id, before.rows.map((row) => row.id)],
          )
        ).rows,
      ).toEqual(after.rows);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
