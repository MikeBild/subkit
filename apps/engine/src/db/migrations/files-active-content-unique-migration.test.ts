import { expect, test } from "bun:test";
import { runMigrations } from "../migrate.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const TAG_SUFFIX = "_files_active_content_unique";

test(
  "active content uniqueness lets a deleted file keep the same content hash",
  async () => {
    const target = EMBEDDED_MIGRATIONS.find((migration) => migration.tag.endsWith(TAG_SUFFIX));
    if (!target) throw new Error(`${TAG_SUFFIX} is not embedded`);
    const baseline = EMBEDDED_MIGRATIONS.filter((migration) => migration.idx < target.idx);
    const ctx = await createTestDb("files_active_content_unique", baseline);
    try {
      const { rows: tenants } = await ctx.pool.query<{ id: string }>(
        "INSERT INTO tenants (slug, display_name) VALUES ('active-content', 'Active content') RETURNING id",
      );
      const tenantId = tenants[0]?.id;
      if (!tenantId) throw new Error("test tenant was not created");
      const insertFile = (name: string, deletedAt: string | null) =>
        ctx.pool.query(
          `INSERT INTO files (tenant_id, filename, storage_uri, sha256, deleted_at)
           VALUES ($1, $2, $3, 'shared-hash', $4)`,
          [tenantId, name, `memory://${name}`, deletedAt],
        );
      await insertFile("deleted.txt", "2026-11-24T06:30:41Z");
      await expect(insertFile("active.txt", null)).rejects.toThrow("files_tenant_sha256_uq");

      expect(
        await runMigrations(
          ctx.db,
          EMBEDDED_MIGRATIONS.filter((migration) => migration.idx <= target.idx),
        ),
      ).toMatchObject({ applied: 1 });

      await insertFile("active.txt", null);
      await expect(insertFile("second-active.txt", null)).rejects.toThrow("files_tenant_sha256_uq");
      const { rows } = await ctx.pool.query(
        "SELECT filename, deleted_at IS NULL AS active FROM files ORDER BY filename",
      );
      expect(rows).toEqual([
        { filename: "active.txt", active: true },
        { filename: "deleted.txt", active: false },
      ]);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
