import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, count, eq, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { createDbFromUrl } from "../../db/client.ts";
import { auditLog, fileLinks, files, tenants } from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../../storage/object-store.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  FILES_CLEANUP_BATCH_SIZE,
  FILES_UNLINKED_CLEANUP_BATCH_SIZE,
  runFilesCleanup,
} from "../files-cleanup-runner.ts";
import { createFilesCleanupBoss, disposeBoss } from "./pgboss-bootstrap.ts";

const uuid = createDeterministicUuidFactory(0xf11ec);
const store = new MemoryObjectStore();
let fixture: TestDb;
let boss: PgBoss;
beforeAll(async () => {
  fixture = await createTestDb("files_cleanup_bounds");
  boss = await createFilesCleanupBoss(fixture.url);
  setObjectStoreForTesting(store);
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  setObjectStoreForTesting(null);
  if (boss) await disposeBoss(boss);
  if (fixture) await fixture.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function seed(kind: "pending" | "scanning" | "soft" | "hard", amount: number) {
  const tenantId = uuid();
  await fixture.db
    .insert(tenants)
    .values({ id: tenantId, slug: tenantId, display_name: "Cleanup fixture" });
  const old = new Date(getTestNow() - 9 * 86400000);
  const rows = Array.from({ length: amount }, () => ({
    id: uuid(),
    tenant_id: tenantId,
    filename: "fixture",
    storage_uri: `memory://${uuid()}`,
    size_bytes: 0,
    status: kind === "soft" || kind === "hard" ? ("ready" as const) : kind,
    created_at: old,
    deleted_at: kind === "hard" ? old : null,
    upload_url_expires_at: kind === "pending" ? old : null,
  }));
  await fixture.db.insert(files).values(rows);
  return { tenantId, rows };
}
const run = () => runFilesCleanup(new Date(getTestNow()), fixture.db, boss, fixture.pool);

for (const kind of ["pending", "scanning", "soft", "hard"] as const) {
  test(
    `${kind} backlog advances through bounded pages without changing fresh neighbors`,
    async () => {
      const batchSize =
        kind === "soft" || kind === "hard"
          ? FILES_UNLINKED_CLEANUP_BATCH_SIZE
          : FILES_CLEANUP_BATCH_SIZE;
      const f = await seed(kind, batchSize * 2 + 1);
      const freshId = uuid();
      await fixture.db.insert(files).values({
        id: freshId,
        tenant_id: f.tenantId,
        filename: "fresh",
        storage_uri: `memory://${freshId}`,
        size_bytes: 0,
        status: "pending",
        upload_url_expires_at: new Date(getTestNow() + 86400000),
      });
      try {
        const remaining = async () => {
          const [row] = await fixture.db
            .select({ n: count() })
            .from(files)
            .where(
              and(
                eq(files.tenant_id, f.tenantId),
                eq(files.status, kind === "soft" || kind === "hard" ? "ready" : kind),
                kind === "soft" ? isNull(files.deleted_at) : undefined,
              ),
            );
          return Number(row?.n ?? 0) - (kind === "pending" ? 1 : 0);
        };
        for (const expected of [batchSize + 1, 1, 0]) {
          await run();
          expect(await remaining()).toBe(expected);
          expect(
            await fixture.db
              .select({ id: files.id })
              .from(files)
              .where(and(eq(files.tenant_id, f.tenantId), eq(files.id, freshId))),
          ).toHaveLength(1);
        }
      } finally {
        await fixture.db.delete(tenants).where(eq(tenants.id, f.tenantId));
      }
    },
    TEST_DB_HOOK_TIMEOUT,
  );
}

for (const kind of ["soft", "hard"] as const) {
  test(
    `${kind} cleanup advances past a protected page`,
    async () => {
      const f = await seed(kind, FILES_UNLINKED_CLEANUP_BATCH_SIZE + 1);
      const ordered = [...f.rows].sort((a, b) => a.id.localeCompare(b.id));
      const free = ordered.at(-1);
      if (!free) throw new Error("cleanup_fixture_missing");
      await fixture.db.insert(fileLinks).values(
        ordered.slice(0, FILES_UNLINKED_CLEANUP_BATCH_SIZE).map((row) => ({
          tenant_id: f.tenantId,
          file_id: row.id,
          resource_type: "conversation" as const,
          resource_id: uuid(),
        })),
      );
      const isolated = createDbFromUrl(fixture.url);
      try {
        const runIsolated = () =>
          runFilesCleanup(new Date(getTestNow()), isolated.db, boss, fixture.pool);
        await runIsolated();
        expect(await fixture.db.select().from(files).where(eq(files.id, free.id))).toHaveLength(1);
        await runIsolated();
        const [freeAfter] = await fixture.db.select().from(files).where(eq(files.id, free.id));
        if (kind === "soft") expect(freeAfter?.deleted_at).not.toBeNull();
        else expect(freeAfter).toBeUndefined();
        expect(
          await fixture.db
            .select({ id: files.id })
            .from(files)
            .where(eq(files.tenant_id, f.tenantId)),
        ).toHaveLength(
          kind === "soft"
            ? FILES_UNLINKED_CLEANUP_BATCH_SIZE + 1
            : FILES_UNLINKED_CLEANUP_BATCH_SIZE,
        );
      } finally {
        await isolated.pool.end();
        await fixture.db.delete(tenants).where(eq(tenants.id, f.tenantId));
      }
    },
    TEST_DB_HOOK_TIMEOUT,
  );
}

test("a held scan row is skipped while another owner makes progress and is retried later", async () => {
  const f = await seed("scanning", 2);
  const locked = f.rows[0];
  if (!locked) throw new Error("cleanup_fixture_missing");
  const client = await fixture.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM subkit.files WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      f.tenantId,
      locked.id,
    ]);
    await run();
    const rows = await fixture.db
      .select({ id: files.id, status: files.status })
      .from(files)
      .where(eq(files.tenant_id, f.tenantId));
    expect(rows.find((row) => row.id === locked.id)?.status).toBe("scanning");
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(1);
    await client.query("ROLLBACK");
    await run();
    expect(
      await fixture.db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.tenant_id, f.tenantId), eq(files.status, "scanning"))),
    ).toHaveLength(0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await fixture.db.delete(tenants).where(eq(tenants.id, f.tenantId));
  }
});

test("scan timeout mutation rolls back when its mandatory audit cannot persist", async () => {
  const f = await seed("scanning", 2);
  await fixture.pool.query(
    "CREATE FUNCTION subkit.test_scan_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='file.scan_completed' THEN RAISE EXCEPTION 'synthetic_scan_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_scan_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_scan_audit_failure()",
  );
  try {
    await run();
    expect(
      await fixture.db
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.tenant_id, f.tenantId), eq(files.status, "scanning"))),
    ).toHaveLength(2);
    expect(
      await fixture.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, f.tenantId), eq(auditLog.action, "file.scan_completed"))),
    ).toHaveLength(0);
  } finally {
    await fixture.pool.query(
      "DROP TRIGGER test_scan_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_scan_audit_failure()",
    );
    await fixture.db.delete(tenants).where(eq(tenants.id, f.tenantId));
  }
});

test("an object-error prefix does not starve a later expired pending key", async () => {
  const f = await seed("pending", FILES_CLEANUP_BATCH_SIZE + 1);
  const ordered = [...f.rows].sort((a, b) => a.id.localeCompare(b.id));
  const blocked = new Set(
    ordered
      .slice(0, FILES_CLEANUP_BATCH_SIZE)
      .map((row) => row.storage_uri.slice("memory://".length)),
  );
  const original = store.delete.bind(store);
  const deletion = spyOn(store, "delete").mockImplementation(async (key) => {
    if (blocked.has(key)) throw new Error("synthetic_object_failure");
    await original(key);
  });
  try {
    await run();
    expect(
      await fixture.db.select({ id: files.id }).from(files).where(eq(files.tenant_id, f.tenantId)),
    ).toHaveLength(257);
    await run();
    expect(
      await fixture.db.select({ id: files.id }).from(files).where(eq(files.tenant_id, f.tenantId)),
    ).toHaveLength(256);
  } finally {
    deletion.mockRestore();
    await fixture.db.delete(tenants).where(eq(tenants.id, f.tenantId));
  }
});
