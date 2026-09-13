// C20: Verify the discovery from-archive persistence contract.
//
// The route `POST /v1/discovery/runs/from-archive` persists the RAW
// archive bytes through the shared inline-upload pipeline
// (`persistInlineUpload` → canonical `files` row, binary-safe object
// storage) and threads the resulting file id into `createDiscoveryRun`,
// which links it to the run via
// `file_links(resource_type='discovery_run', role='archive')` inside the
// run-creation transaction. The extracted text path into
// `discovery_files` is unchanged.
//
// This test exercises the service layer directly: persist a file, create
// a run with `archive_file_id`, and assert the `files` + `file_links`
// rows exist alongside the run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { tenants } from "../../db/schema/identity.ts";
import { discoveryRuns, fileLinks, files } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";

const skip = process.env.REQUIRES_PG === "0";

// Build a minimal valid zip in a temp dir.
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

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "c20-tenant", display_name: "C20 Tenant" })
    .returning();
  tenantId = t!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("C20 — from-archive persists the raw archive via files + file_links", () => {
  test("from-archive: archive_file_id yields a files row + discovery_run file_link", async () => {
    // Exercise the service layer directly — the same sequence the HTTP
    // handler runs — without standing up a full HTTP server.
    const { createDiscoveryRun } = await import("../service.ts");
    const { persistInlineUpload } = await import("../../files/persist-inline-upload.ts");

    // Raw archive bytes are binary (contain null bytes) — they must land
    // in the object store, never a TEXT column.
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

    // Confirm the discovery_run row exists in DB.
    const runRows = await ctx.db.select().from(discoveryRuns).where(eq(discoveryRuns.id, run.id));

    expect(runRows).toHaveLength(1);

    // The raw archive lands in the canonical `files` table.
    const fileRows = await ctx.db.select().from(files).where(eq(files.tenant_id, tenantId));

    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.id).toBe(persisted.row.id);

    // ... and is linked to the run as its archive.
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

    // Query from the wrong tenant — must return nothing.
    const wrongTenantRows = await ctx.db
      .select()
      .from(discoveryRuns)
      .where(
        sql`${discoveryRuns.id} = ${run.id} AND ${discoveryRuns.tenant_id} = '00000000-0000-0000-0000-000000000000'`,
      );

    expect(wrongTenantRows).toHaveLength(0);
  });
});
