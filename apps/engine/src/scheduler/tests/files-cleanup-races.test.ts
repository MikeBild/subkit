// Race condition tests for the files cleanup cron.
//
// Simulates: cron selects a fid for unlinked sweep, then soft-deletes it.
// The workflow must still be able to read the file (soft-delete grace honored
// via the `requireFileForTenant` path that ignores `deleted_at`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fileLinks, files } from "../../db/schema/index.ts";
import { requireFileForTenant, resolvedFromRow } from "../../files/resolver.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { runFilesCleanup } from "../files-cleanup-runner.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("files-cleanup-races");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("files cleanup race — soft-delete grace", () => {
  test("soft-deleted file is still readable via requireFileForTenant (grace window)", async () => {
    const convId = randomUUID();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "race-grace.txt",
      content: "race-grace-content",
      slug: `race-grace-${randomUUID().slice(0, 8)}`,
    });
    // Remove the link so it becomes an unlinked candidate
    await srv.db.delete(fileLinks).where(eq(fileLinks.file_id, att.file_uuid));

    // Run cleanup — this will soft-delete the file
    await runFilesCleanup(new Date(), srv.db);

    // File should now be soft-deleted but not hard-deleted
    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).not.toBeNull();

    // A workflow holding a ref can still read it via requireFileForTenant
    // (ignores deleted_at per the grace contract)
    const resolvedRow = await requireFileForTenant(srv.db, srv.tenantId, att.file_uuid);
    expect(resolvedRow).toBeDefined();
    expect(resolvedRow.filename).toBe("race-grace.txt");

    // Bytes are still readable via openRead
    const resolved = resolvedFromRow(resolvedRow);
    const stream = await resolved.openRead();
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    expect(text).toBe("race-grace-content");
  });

  test("file with active link is not soft-deleted by cron", async () => {
    const convId = randomUUID();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "race-relink.txt",
      content: "race-relink-content",
      slug: `race-relink-${randomUUID().slice(0, 8)}`,
    });
    // The link already exists from attachInlineForTest — this file is LINKED.

    await runFilesCleanup(new Date(), srv.db);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeNull();
    expect(row!.status).toBe("ready");
  });
});
