import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { users } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";

test(
  "a user has an optional display name without default",
  async () => {
    const ctx = await createTestDb("user_display_name");
    try {
      const {
        rows: [tenant],
      } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"user-display-name-migration"}, ${"User display name"}) RETURNING id
  `);
      if (!tenant) throw new Error("test tenant was not created");
      const roleId = await builtinRoleId(ctx.db, "member");
      const { rows } = await ctx.pool.query(
        "INSERT INTO users (tenant_id, email, role_id) VALUES ($1, $2, $3) RETURNING id, email",
        [tenant.id, "legacy@test.local", roleId],
      );
      const legacyUser = rows[0] as { id: string; email: string } | undefined;
      if (!legacyUser) throw new Error("legacy test user was not created");

      const [user] = await ctx.db
        .select({ email: users.email, display_name: users.display_name })
        .from(users)
        .where(sql`${users.id} = ${legacyUser.id}`);
      expect(user).toEqual({ email: "legacy@test.local", display_name: null });
      const columns = await ctx.db.execute(sql`
        SELECT is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'subkit'
           AND table_name = 'users'
           AND column_name = 'display_name'
      `);
      expect(
        (columns as unknown as { rows: { is_nullable: string; column_default: string | null }[] })
          .rows,
      ).toEqual([{ is_nullable: "YES", column_default: null }]);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
