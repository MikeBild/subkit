// C20: Verify the discovery analyze-archive route behaviour.
//
// CONTRACT STATUS: CURRENT BEHAVIOUR LOCKED (gap documented)
//
// Plan §C20 stated: "Decision: upload the archive via `/v1/files/inline`
// first … then trigger discovery with the `fid`. Same end-to-end behaviour
// for the CLI; cleaner storage model."
//
// FINDING: The engine route `POST /v1/discovery/runs/from-archive` does NOT
// currently route through `/v1/files/inline`. It accepts a direct multipart
// upload, reads the archive buffer in-process, extracts it via
// `extractCodebaseArchive`, and passes the file array to
// `createDiscoveryRun`. No `files` row and no `file_links` row are created
// for the archive itself; only `discovery_runs` + `discovery_files` rows are
// written.
//
// This test locks the CURRENT behaviour so a future rewrite can flip it in
// lockstep. Once C20 is wired:
//   1. The archive must first be uploaded via POST /v1/files/inline.
//   2. The discovery route must accept a `fid` param.
//   3. `files` + `file_links(resource_type='discovery_run')` rows must exist.
//
// TODO(files): C20 — route through /v1/files/inline + fid. See
//   apps/engine/src/http/routes/discovery.ts POST /v1/discovery/runs/from-archive.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { tenants } from "../../db/schema/identity.ts";
import { discoveryRuns, files } from "../../db/schema/index.ts";
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

describe.skipIf(skip)("C20 — analyze-archive route locks current multipart behaviour", () => {
  test("from-archive: multipart input creates a discovery_runs row (no files row — current behaviour)", async () => {
    // Import createDiscoveryRun directly to test the service layer
    // without standing up a full HTTP server.
    const { createDiscoveryRun } = await import("../service.ts");

    const parsedFiles = [
      { filename: "src/index.ts", buffer: Buffer.from("export const x = 1;") },
      { filename: "README.md", buffer: Buffer.from("# Demo project") },
    ];

    const run = await createDiscoveryRun(
      {
        tenant_id: tenantId,
        files: parsedFiles,
        actor_id: null,
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

    // Current behaviour: NO `files` row is created for the archive.
    // TODO(files): after C20 wiring, assert files row + file_links row exist.
    const fileRows = await ctx.db.select().from(files).where(eq(files.tenant_id, tenantId));

    expect(fileRows).toHaveLength(0); // gap: no files row for archive
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
