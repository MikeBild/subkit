import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { fileLinks, files } from "../../db/schema/index.ts";
import { requireFileForTenant, resolvedFromRow } from "../../files/resolver.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runFilesCleanup } from "../files-cleanup-runner.ts";
import { createFilesCleanupBoss, disposeBoss } from "./pgboss-bootstrap.ts";

const uuid = createDeterministicUuidFactory(0xface01);

let srv: HttpTestServer;
let boss: PgBoss;

beforeAll(async () => {
  srv = await createHttpTestServer("files-cleanup-races");
  boss = await createFilesCleanupBoss(srv.testDb.url);
}, 60_000);

afterAll(async () => {
  await disposeBoss(boss);
  await srv.cleanup();
}, 30_000);

describe("files cleanup race — soft-delete grace", () => {
  test("soft-deleted file is still readable via requireFileForTenant (grace window)", async () => {
    const convId = uuid();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "race-grace.txt",
      content: "race-grace-content",
      slug: `race-grace-${uuid().slice(0, 8)}`,
    });
    await srv.db.delete(fileLinks).where(eq(fileLinks.file_id, att.file_uuid));

    await runFilesCleanup(new Date(FROZEN_NOW), srv.db, boss, srv.testDb.pool);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).not.toBeNull();

    const resolvedRow = await requireFileForTenant(srv.db, srv.tenantId, att.file_uuid);
    expect(resolvedRow).toBeDefined();
    expect(resolvedRow.filename).toBe("race-grace.txt");

    const resolved = resolvedFromRow(resolvedRow);
    const stream = await resolved.openRead();
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    expect(text).toBe("race-grace-content");
  });

  test("file with active link is not soft-deleted by cron", async () => {
    const convId = uuid();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "race-relink.txt",
      content: "race-relink-content",
      slug: `race-relink-${uuid().slice(0, 8)}`,
    });

    await runFilesCleanup(new Date(FROZEN_NOW), srv.db, boss, srv.testDb.pool);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeNull();
    expect(row!.status).toBe("ready");
  });
});
