import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, notExists, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  auditLog,
  conversationMessages,
  conversations,
  executions,
  fileLinks,
  files,
  tenants,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import { runFilesCleanup } from "../scheduler/files-cleanup-runner.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../storage/object-store.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { FileLinkError, linkStoredFile } from "./links.ts";
import { removeStoredFile } from "./remove-stored-file.ts";

const uuid = createDeterministicUuidFactory(0x51ef1e);
const store = new MemoryObjectStore();
const context = {
  actor_type: "system" as const,
  actor_id: null,
  request_source: "api" as const,
  allowed_statuses: ["ready"] as const,
};
let fixture: TestDb;
let boss: PgBoss;
beforeAll(async () => {
  fixture = await createTestDb("file_reference_authority");
  boss = await createBoss({ connectionString: fixture.url });
  setObjectStoreForTesting(store);
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  setObjectStoreForTesting(null);
  if (boss) await disposeBoss(boss);
  if (fixture) await fixture.cleanup();
}, TEST_DB_HOOK_TIMEOUT);
async function file() {
  const tenantId = uuid();
  const id = uuid();
  await fixture.db
    .insert(tenants)
    .values({ id: tenantId, slug: tenantId, display_name: "File reference fixture" });
  await fixture.db.insert(files).values({
    id,
    tenant_id: tenantId,
    filename: "fixture.txt",
    status: "ready",
    storage_uri: `memory://${id}`,
    size_bytes: 4,
  });
  await store.put(id, new Uint8Array([1, 2, 3, 4]));
  return {
    tenantId,
    id,
    input: {
      tenant_id: tenantId,
      file_id: id,
      resource_type: "conversation" as const,
      resource_id: uuid(),
      slug: "attachment",
      role: "attachment",
    },
  };
}
function unlinked() {
  return notExists(
    sql`(SELECT 1 FROM ${fileLinks} WHERE ${fileLinks.tenant_id}=${files.tenant_id} AND ${fileLinks.file_id}=${files.id})`,
  );
}

test("same exact link is idempotent and its mandatory audit commits with the new link", async () => {
  const f = await file();
  const first = await linkStoredFile(fixture.db, f.input, context);
  expect((await linkStoredFile(fixture.db, f.input, context)).id).toBe(first.id);
  expect(
    await fixture.db.select().from(fileLinks).where(eq(fileLinks.tenant_id, f.tenantId)),
  ).toHaveLength(1);
  const rows = await fixture.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, f.tenantId), eq(auditLog.action, "file.link_added")));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.metadata).toMatchObject({
    request_source: "api",
    file_id: f.id,
    resource_id: f.input.resource_id,
  });
});

test("foreign file owner and stale deleted/status admission cannot create links", async () => {
  const f = await file();
  const other = await file();
  await expect(
    linkStoredFile(fixture.db, { ...f.input, tenant_id: other.tenantId }, context),
  ).rejects.toBeInstanceOf(FileLinkError);
  await fixture.db
    .update(files)
    .set({ deleted_at: new Date(getTestNow()) })
    .where(eq(files.id, f.id));
  await expect(linkStoredFile(fixture.db, f.input, context)).rejects.toMatchObject({
    code: "file_unavailable",
  });
  await fixture.db
    .update(files)
    .set({ deleted_at: null, status: "pending" })
    .where(eq(files.id, f.id));
  await expect(linkStoredFile(fixture.db, f.input, context)).rejects.toMatchObject({
    code: "file_unavailable",
  });
  await expect(
    linkStoredFile(fixture.db, f.input, { ...context, allowed_statuses: ["pending"] }),
  ).resolves.toBeDefined();
});

test("same resource slug for another file cannot be reported as a successful link", async () => {
  const f = await file();
  const otherId = uuid();
  await fixture.db.insert(files).values({
    id: otherId,
    tenant_id: f.tenantId,
    filename: "other.txt",
    status: "ready",
    storage_uri: `memory://${otherId}`,
    size_bytes: 0,
  });
  await linkStoredFile(fixture.db, f.input, context);
  await expect(
    linkStoredFile(fixture.db, { ...f.input, file_id: otherId }, context),
  ).rejects.toMatchObject({ code: "file_link_conflict" });
});

test("mandatory link audit failure rolls back link insertion", async () => {
  const f = await file();
  await fixture.pool.query(
    "CREATE FUNCTION subkit.test_file_link_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='file.link_added' THEN RAISE EXCEPTION 'synthetic_file_link_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_file_link_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_file_link_audit_failure()",
  );
  try {
    await expect(linkStoredFile(fixture.db, f.input, context)).rejects.toThrow();
    expect(
      await fixture.db.select().from(fileLinks).where(eq(fileLinks.tenant_id, f.tenantId)),
    ).toHaveLength(0);
  } finally {
    await fixture.pool.query(
      "DROP TRIGGER test_file_link_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_file_link_audit_failure()",
    );
  }
});

test("fresh post-lock predicate sees an FK link committed while cleanup waited", async () => {
  const f = await file();
  const client = await fixture.pool.connect();
  const deletion = spyOn(store, "delete");
  let removing: ReturnType<typeof removeStoredFile> | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO subkit.file_links(tenant_id,file_id,resource_type,resource_id,slug) VALUES($1,$2,'conversation',$3,'attachment')",
      [f.tenantId, f.id, f.input.resource_id],
    );
    removing = removeStoredFile(fixture.db, f.tenantId, f.id, unlinked());
    await waitFor(
      async () => {
        const rows = await fixture.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%for update%' AND pid<>pg_backend_pid()",
        );
        return rows.rowCount === 1;
      },
      { tries: 400, sleepMs: 5 },
    );
    await client.query("COMMIT");
    expect(await removing).toBeUndefined();
    expect(deletion).not.toHaveBeenCalled();
    expect(await store.head(f.id)).not.toBeNull();
    expect(await fixture.db.select().from(files).where(eq(files.id, f.id))).toHaveLength(1);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    if (removing) await removing;
    deletion.mockRestore();
  }
}, 10_000);

test("successful link refuses cleanup and an unlinked neighbor remains removable", async () => {
  const linked = await file();
  const neighbor = await file();
  await linkStoredFile(fixture.db, linked.input, context);
  expect(
    await removeStoredFile(fixture.db, linked.tenantId, linked.id, unlinked()),
  ).toBeUndefined();
  expect((await removeStoredFile(fixture.db, neighbor.tenantId, neighbor.id, unlinked()))?.id).toBe(
    neighbor.id,
  );
  expect(await store.head(linked.id)).not.toBeNull();
  expect(await store.head(neighbor.id)).toBeNull();
});

async function cleanup() {
  await runFilesCleanup(new Date(getTestNow()), fixture.db, boss, fixture.pool);
}
async function workflow(tenantId: string, dag: unknown) {
  const id = uuid();
  const versionId = uuid();
  await fixture.db
    .insert(workflows)
    .values({ id, tenant_id: tenantId, slug: id, name: "Reference fixture", lifecycle: "active" });
  await fixture.db
    .insert(workflowVersions)
    .values({ id: versionId, tenant_id: tenantId, workflow_id: id, version: 1, dag });
  await fixture.db
    .update(workflows)
    .set({ current_version_id: versionId })
    .where(eq(workflows.id, id));
  return { id, versionId };
}
async function currentFile(id: string) {
  return (await fixture.db.select().from(files).where(eq(files.id, id)))[0];
}

test("retained old DAG and paused schedule intent protect hard and soft cleanup", async () => {
  const hard = await file();
  await fixture.db
    .update(files)
    .set({ deleted_at: new Date(getTestNow() - 8 * 86_400_000) })
    .where(eq(files.id, hard.id));
  const w = await workflow(hard.tenantId, {
    steps: [{ body: { $file: `fid_${hard.id.toUpperCase()}` } }],
  });
  const next = uuid();
  await fixture.db.insert(workflowVersions).values({
    id: next,
    tenant_id: hard.tenantId,
    workflow_id: w.id,
    version: 2,
    dag: { steps: [] },
  });
  await fixture.db
    .update(workflows)
    .set({ current_version_id: next })
    .where(eq(workflows.id, w.id));
  const scheduled = await file();
  await fixture.db
    .update(files)
    .set({ slug: "scheduled-source" })
    .where(eq(files.id, scheduled.id));
  const sw = await workflow(scheduled.tenantId, { steps: [] });
  await fixture.db.insert(workflowsSchedules).values({
    tenant_id: scheduled.tenantId,
    workflow_id: sw.id,
    cron: "* * * * *",
    paused: true,
    input: { file: { $file: "@attachment:scheduled-source" } },
  });
  await cleanup();
  expect(await currentFile(hard.id)).toBeDefined();
  expect(await store.head(hard.id)).not.toBeNull();
  expect((await currentFile(scheduled.id))?.deleted_at).toBeNull();
});

test("queued and running execution scope protects computed references until settlement", async () => {
  const f = await file();
  const executionId = uuid();
  const neighbor = await file();
  await fixture.db.insert(executions).values({
    id: executionId,
    tenant_id: f.tenantId,
    source_kind: "draft",
    execution_mode: "dev",
    status: "queued",
    request_source: "api",
    input: { compute_from_remote: true },
    hold_writes: true,
  });
  for (let pass = 0; pass < 10; pass++) {
    await cleanup();
    if ((await currentFile(neighbor.id))?.deleted_at) break;
  }
  expect((await currentFile(f.id))?.deleted_at).toBeNull();
  expect((await currentFile(neighbor.id))?.deleted_at).not.toBeNull();
  await fixture.db
    .update(executions)
    .set({ status: "running" })
    .where(eq(executions.id, executionId));
  await cleanup();
  expect((await currentFile(f.id))?.deleted_at).toBeNull();
  await fixture.db
    .update(executions)
    .set({ status: "failed" })
    .where(eq(executions.id, executionId));
  for (let attempt = 0; attempt < 8; attempt++) {
    await cleanup();
    if ((await currentFile(f.id))?.deleted_at) break;
  }
  expect((await currentFile(f.id))?.deleted_at).not.toBeNull();
});

test("retained conversation slug intent protects only its owning tenant", async () => {
  const intended = await file();
  const neighbor = await file();
  for (const f of [intended, neighbor])
    await fixture.db.update(files).set({ slug: "intent-source" }).where(eq(files.id, f.id));
  const conversationId = uuid();
  await fixture.db.insert(conversations).values({
    id: conversationId,
    tenant_id: intended.tenantId,
    status: "active",
    draft: { pending: { file: { $file: "@attachment:intent-source" } } },
  });
  await fixture.db.insert(conversationMessages).values({
    tenant_id: intended.tenantId,
    conversation_id: conversationId,
    role: "user",
    content: { text: "Review @attachment:intent-source" },
  });
  await cleanup();
  expect((await currentFile(intended.id))?.deleted_at).toBeNull();
  expect((await currentFile(neighbor.id))?.deleted_at).not.toBeNull();
});
