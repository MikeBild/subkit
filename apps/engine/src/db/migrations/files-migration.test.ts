// Smoke-test for the 0019_files_unify migration.
//
// The createTestDb helper always runs ALL migrations, so we cannot
// replay a "stop at 0018" state without a more complex harness. Instead,
// this test verifies the post-migration state: the new tables exist, the
// legacy conversation_attachments table is absent, and the unified files
// resource is functional (insert + query round-trip).
//
// Limitation documented: a pre-backfill replay harness does not exist in
// this repo. The correctness of the backfill SQL is covered by the SQL's
// own row-count assertions (¶7 in 0019_files_unify.sql) which abort the
// migration transaction if the counts disagree.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { fileLinks, files, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("files_migration_smoke");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function tableExists(name: string): Promise<boolean> {
  const r = (await ctx.db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'subkit' AND table_name = ${name}
    ) AS "exists"
  `)) as unknown as { rows: Array<{ exists: boolean }> };
  return Boolean(r.rows?.[0]?.exists);
}

describe("0019_files_unify — post-migration schema smoke", () => {
  test("files table exists", async () => {
    expect(await tableExists("files")).toBe(true);
  });

  test("file_links table exists", async () => {
    expect(await tableExists("file_links")).toBe(true);
  });

  test("conversation_attachments table was dropped", async () => {
    expect(await tableExists("conversation_attachments")).toBe(false);
  });

  test("knowledge_sources.file_id column exists (added by migration)", async () => {
    const r = (await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'subkit'
        AND table_name = 'knowledge_sources'
        AND column_name = 'file_id'
    `)) as unknown as { rows: Array<{ column_name: string }> };
    expect(r.rows?.length).toBeGreaterThanOrEqual(1);
  });

  test("files unique index (tenant_id, sha256) enforces dedup", async () => {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "files-mig-dedup", display_name: "Dedup T" })
      .returning();
    const tenant_id = t!.id;

    // First insert succeeds.
    await ctx.db.insert(files).values({
      tenant_id,
      status: "ready",
      filename: "dup.txt",
      size_bytes: 3,
      storage_uri: "local://dup",
      sha256: "aabbccdd",
      scan_result: "clean",
    });

    // Second insert with same (tenant_id, sha256) must throw.
    let threw = false;
    try {
      await ctx.db.insert(files).values({
        tenant_id,
        status: "ready",
        filename: "dup2.txt",
        size_bytes: 3,
        storage_uri: "local://dup2",
        sha256: "aabbccdd",
        scan_result: "clean",
      });
    } catch (err) {
      threw = true;
      const inner = (err as { cause?: { message?: string } }).cause?.message ?? String(err);
      expect(inner).toContain("files_tenant_sha256_uq");
    }
    expect(threw).toBe(true);
  });

  test("file_links round-trip: insert and query by resource_type", async () => {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "files-mig-link", display_name: "Link T" })
      .returning();
    const tenant_id = t!.id;

    const [f] = await ctx.db
      .insert(files)
      .values({
        tenant_id,
        status: "ready",
        filename: "linked.txt",
        size_bytes: 4,
        storage_uri: "local://linked",
        sha256: "deadbeef01",
        scan_result: "clean",
      })
      .returning();

    const fakeConvId = "00000000-0000-0000-0000-000000000001";
    await ctx.db.insert(fileLinks).values({
      tenant_id,
      file_id: f!.id,
      resource_type: "conversation",
      resource_id: fakeConvId,
      slug: "linked-doc",
      role: "attachment",
    });

    const rows = await ctx.db
      .select()
      .from(fileLinks)
      .where(sql`tenant_id = ${tenant_id} AND resource_type = 'conversation'`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.slug).toBe("linked-doc");
  });

  test("file_status enum accepts all expected values", async () => {
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "files-mig-status", display_name: "Status T" })
      .returning();
    const tenant_id = t!.id;

    const statuses = ["pending", "uploading", "scanning", "ready", "failed", "expired"] as const;
    for (const status of statuses) {
      const sha = `status-${status}-test01`;
      await ctx.db.insert(files).values({
        tenant_id,
        status,
        filename: `${status}.txt`,
        size_bytes: 1,
        storage_uri: `local://${status}`,
        sha256: sha,
        scan_result: null,
      });
    }

    const r = (await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM files WHERE tenant_id = ${tenant_id}`,
    )) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows?.[0]?.n).toBe(statuses.length);
  });
});
