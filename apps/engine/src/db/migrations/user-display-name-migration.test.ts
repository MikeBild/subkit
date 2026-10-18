import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { runMigrations } from "../migrate.ts";
import { users } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find((item) =>
  item.statements.some((statement) => statement.includes('ADD COLUMN "display_name" text')),
);

test(
  "adds an optional display name without changing existing users",
  async () => {
    if (!migration) throw new Error("display name migration is not embedded");
    const ctx = await createTestDb("user_display_name", { upToIdx: migration.idx - 1 });
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

      const first = await runMigrations(ctx.db, [migration], true);
      expect(first.applied).toBe(1);
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
      expect((await runMigrations(ctx.db, [migration], true)).applied).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
