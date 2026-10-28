import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { files, packageInstalls } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { PACKAGE_CONTENT_TYPE } from "../../identity/portability/format.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runFilesCleanup } from "../files-cleanup-runner.ts";
import { createFilesCleanupBoss, disposeBoss } from "./pgboss-bootstrap.ts";

const uuid = createDeterministicUuidFactory(0xface0a);

let srv: HttpTestServer;
let boss: PgBoss;

beforeAll(async () => {
  srv = await createHttpTestServer("files-cleanup-package-archives");
  boss = await createFilesCleanupBoss(srv.testDb.url);
}, 60_000);

afterAll(async () => {
  await disposeBoss(boss);
  await srv.cleanup();
}, 30_000);

async function packageArchive(age: "fresh" | "old", deleted?: "long_ago"): Promise<string> {
  const id = uuid();
  await srv.db.insert(files).values({
    id,
    tenant_id: srv.tenantId,
    status: "ready",
    filename: `${id}.subkit-package.zip`,
    content_type: PACKAGE_CONTENT_TYPE,
    storage_uri: `local://${srv.tenantId}/packages/${id}`,
    size_bytes: 2048,
    ...(age === "old" ? { created_at: sql`now() - interval '2 days'` } : {}),
    ...(deleted ? { deleted_at: sql`now() - interval '8 days'` } : {}),
  });
  return id;
}

async function install(archive_file_id: string): Promise<void> {
  await srv.db.insert(packageInstalls).values({
    tenant_id: srv.tenantId,
    package_id: `tenant-export:test:${archive_file_id}`,
    package_version: "1",
    format: "subkit-package/v1",
    content_digest: archive_file_id,
    archive_file_id,
    installed_by_type: "user",
  });
}

async function row(id: string) {
  const [found] = await srv.db.select().from(files).where(eq(files.id, id));
  return found;
}

async function sweep() {
  await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);
}

describe("file cleanup and package archives", () => {
  test("a fresh package archive survives so a preview can still be applied", async () => {
    const id = await packageArchive("fresh");
    await sweep();
    expect((await row(id))?.deleted_at).toBeNull();
  });

  test("an unused package archive is cleaned up once it is a day old", async () => {
    const id = await packageArchive("old");
    await sweep();
    expect((await row(id))?.deleted_at).not.toBeNull();
  });

  test("the archive of an installed package is never cleaned up", async () => {
    const kept = await packageArchive("old");
    await install(kept);
    const softDeletedLongAgo = await packageArchive("old", "long_ago");
    await install(softDeletedLongAgo);
    await sweep();
    expect((await row(kept))?.deleted_at).toBeNull();
    expect(await row(softDeletedLongAgo)).toBeDefined();
  });
});
