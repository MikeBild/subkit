import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { discoveryRuns, fileLinks, files } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";

const skip = testEnv.REQUIRES_PG === "0";

function _makeZip(entries: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "c20-archive-test-"));
  try {
    for (const [name, content] of Object.entries(entries)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    const archivePath = join(dir, "out.zip");
    execFileSync("zip", ["-qr", archivePath, "."], { cwd: dir });
    const { readFileSync } = require("node:fs");
    return readFileSync(archivePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("c20-archive");

  tenantId = (await seedTenant(ctx.db, { slug: "c20-tenant", display_name: "C20 Tenant" })).id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("C20 — from-archive persists the raw archive via files + file_links", () => {
  test("from-archive: archive_file_id yields a files row + discovery_run file_link", async () => {
    const { createDiscoveryRun } = await import("../service.ts");
    const { persistInlineUpload } = await import("../../files/persist-inline-upload.ts");

    const archiveBytes = Buffer.from("PK\x03\x04\x00\x01\x02-raw-archive-bytes", "binary");
    const persisted = await persistInlineUpload(ctx.db, {
      tenant_id: tenantId,
      actor_id: null,
      filename: "codebase.zip",
      content_type: "application/zip",
      bytes: archiveBytes,
    });
    expect(persisted.row.tenant_id).toBe(tenantId);

    const parsedFiles = [
      { filename: "src/index.ts", buffer: Buffer.from("export const x = 1;") },
      { filename: "README.md", buffer: Buffer.from("# Demo project") },
    ];

    const run = await createDiscoveryRun(
      {
        tenant_id: tenantId,
        files: parsedFiles,
        actor_id: null,
        archive_file_id: persisted.row.id,
      },
      ctx.db,
    );

    expect(run.id).toBeDefined();
    expect(run.tenant_id).toBe(tenantId);
    expect(run.file_count).toBe(2);
    expect(run.status).toBe("pending");

    const runRows = await ctx.db.select().from(discoveryRuns).where(eq(discoveryRuns.id, run.id));

    expect(runRows).toHaveLength(1);

    const fileRows = await ctx.db.select().from(files).where(eq(files.tenant_id, tenantId));

    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.id).toBe(persisted.row.id);

    const linkRows = await ctx.db
      .select()
      .from(fileLinks)
      .where(and(eq(fileLinks.resource_type, "discovery_run"), eq(fileLinks.resource_id, run.id)));

    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]!.tenant_id).toBe(tenantId);
    expect(linkRows[0]!.file_id).toBe(persisted.row.id);
    expect(linkRows[0]!.role).toBe("archive");
  });

  test("from-archive: tenant isolation — run not visible from wrong tenant", async () => {
    const { createDiscoveryRun } = await import("../service.ts");

    const run = await createDiscoveryRun(
      {
        tenant_id: tenantId,
        files: [{ filename: "main.ts", buffer: Buffer.from("const a = 1;") }],
        actor_id: null,
      },
      ctx.db,
    );

    const wrongTenantRows = await ctx.db
      .select()
      .from(discoveryRuns)
      .where(
        sql`${discoveryRuns.id} = ${run.id} AND ${discoveryRuns.tenant_id} = '00000000-0000-0000-0000-000000000000'`,
      );

    expect(wrongTenantRows).toHaveLength(0);
  });
});
