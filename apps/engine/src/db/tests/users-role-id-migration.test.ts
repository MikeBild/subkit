import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "../migrate.ts";
import { roles, users } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "./setup.ts";

test(
  "0078 assigns the built-in role named by users.role before dropping the column",
  async () => {
    const ctx = await createTestDb("users_role_id_upgrade", { upToIdx: 77 });
    try {
      const inserted = (await ctx.db.execute(sql`
        INSERT INTO "tenants" ("slug", "display_name")
        VALUES ('role-id-upgrade', 'Role id upgrade')
        RETURNING "id"
      `)) as unknown as { rows: Array<{ id: string }> };
      const tenant = inserted.rows[0];
      if (!tenant) throw new Error("missing tenant");
      await ctx.db.execute(sql`
        INSERT INTO "users" ("tenant_id", "email", "role", "role_id")
        VALUES (${tenant.id}, 'unassigned@upgrade.test', 'enduser', NULL)
      `);

      await runMigrations(ctx.db);

      const [row] = await ctx.db
        .select({ role_name: roles.name })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.role_id))
        .where(eq(users.email, "unassigned@upgrade.test"));
      expect(row?.role_name).toBe("enduser");
      const column = (await ctx.db.execute(sql`
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'role'
      `)) as unknown as { rows: unknown[] };
      expect(column.rows).toHaveLength(0);
      expect((await runMigrations(ctx.db)).applied).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
