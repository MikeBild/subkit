import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import {
  auditLog,
  fileLinks,
  files,
  hostedTenantUsage,
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceVersions,
} from "../../db/schema/index.ts";
import { waitForTenantWorkDrain } from "../../execution/index.ts";
import { storageKey } from "../../files/resolver.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import {
  type MemoryOffloadStorage,
  useMemoryOffloadStorage,
} from "../../test-helpers/offload-storage.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { createKnowledgeSource, ingestKnowledgeSource } from "../service.ts";

const uuid = createDeterministicUuidFactory(0x51a907);
let ctx: HttpTestServer;
let storage: MemoryOffloadStorage;
beforeAll(async () => {
  ctx = await createHttpTestServer("knowledge_snapshot_links", { operator: false });
  await configureHostedPolicyForTests(ctx.db, ctx.testDb.url);
  storage = await useMemoryOffloadStorage();
});
afterAll(async () => {
  await waitForTenantWorkDrain();
  if (storage) await storage.restore();
  if (ctx) await ctx.cleanup();
});
async function create(tenantId: string, text: string) {
  const result = await createKnowledgeSource(
    {
      tenant_id: tenantId,
      input: { name: uuid(), scope: "global" },
      upload: { buffer: Buffer.from(text), filename: "snapshot.md", mime: "text/markdown" },
      actor: null,
    },
    ctx.db,
  );
  await waitForTenantWorkDrain();
  return result.id;
}
async function source(tenantId: string, id: string) {
  const [row] = await ctx.db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, tenantId), eq(knowledgeSources.id, id)))
    .limit(1);
  if (!row) throw new Error("snapshot_source_fixture_missing");
  return row;
}
async function links(tenantId: string, id: string) {
  return ctx.db
    .select()
    .from(fileLinks)
    .where(
      and(
        eq(fileLinks.tenant_id, tenantId),
        eq(fileLinks.resource_type, "knowledge_source"),
        eq(fileLinks.resource_id, id),
      ),
    );
}
async function ingest(tenantId: string, id: string, text: string) {
  const result = await ingestKnowledgeSource(
    {
      tenant_id: tenantId,
      knowledge_source_id: id,
      upload: { buffer: Buffer.from(text), filename: "snapshot.md", mime: "text/markdown" },
      actor: null,
    },
    ctx.db,
  );
  await waitForTenantWorkDrain();
  return result;
}

test("replacing a source retains original snapshot links and its current file advances atomically", async () => {
  const id = await create(ctx.tenantId, "# Original snapshot");
  const before = await source(ctx.tenantId, id);
  await ctx.db
    .update(fileLinks)
    .set({ slug: before.slug })
    .where(
      and(
        eq(fileLinks.tenant_id, ctx.tenantId),
        eq(fileLinks.resource_type, "knowledge_source"),
        eq(fileLinks.resource_id, id),
      ),
    );
  await ingest(ctx.tenantId, id, "# Replacement snapshot");
  const after = await source(ctx.tenantId, id);
  expect(after.file_id).not.toBe(before.file_id);
  const retained = await links(ctx.tenantId, id);
  expect(retained).toHaveLength(2);
  expect(retained.find((row) => row.file_id === before.file_id)?.slug).toBe(before.slug);
  expect(retained.some((row) => row.file_id === after.file_id)).toBe(true);
  expect(
    await ctx.db
      .select({ id: knowledgeSourceVersions.id })
      .from(knowledgeSourceVersions)
      .where(
        and(
          eq(knowledgeSourceVersions.tenant_id, ctx.tenantId),
          eq(knowledgeSourceVersions.knowledge_source_id, id),
        ),
      ),
  ).toHaveLength(2);
  for (const snapshot of retained) {
    const [file] = await ctx.db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, ctx.tenantId), eq(files.id, snapshot.file_id)));
    if (!file) throw new Error("snapshot_file_fixture_missing");
    expect((await storage.store.get(storageKey(file.storage_uri))).toString()).toBe(
      snapshot.file_id === before.file_id ? "# Original snapshot" : "# Replacement snapshot",
    );
  }
});

test("repeated and restored snapshot bytes reuse their existing source links without another link audit", async () => {
  const id = await create(ctx.tenantId, "# First reusable snapshot");
  const first = await source(ctx.tenantId, id);
  await ingest(ctx.tenantId, id, "# Second reusable snapshot");
  await ingest(ctx.tenantId, id, "# Second reusable snapshot");
  await ingest(ctx.tenantId, id, "# First reusable snapshot");
  expect((await source(ctx.tenantId, id)).file_id).toBe(first.file_id);
  const retained = await links(ctx.tenantId, id);
  expect(retained).toHaveLength(2);
  const audits = await ctx.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "file.link_added")));
  expect(
    audits.filter(
      (row) =>
        row.metadata !== null &&
        typeof row.metadata === "object" &&
        "resource_id" in row.metadata &&
        row.metadata.resource_id === id,
    ),
  ).toHaveLength(2);
});

test("a rejected link audit rolls the source, chunks, versions and snapshot link back together", async () => {
  const id = await create(ctx.tenantId, "# Before audit refusal");
  const before = await source(ctx.tenantId, id);
  const beforeLinks = await links(ctx.tenantId, id);
  const chunks = await ctx.db
    .select()
    .from(knowledgeChunks)
    .where(
      and(eq(knowledgeChunks.tenant_id, ctx.tenantId), eq(knowledgeChunks.knowledge_source_id, id)),
    );
  const versions = await ctx.db
    .select()
    .from(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, ctx.tenantId),
        eq(knowledgeSourceVersions.knowledge_source_id, id),
      ),
    );
  await ctx.testDb.pool.query(
    "CREATE FUNCTION subkit.test_snapshot_link_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='file.link_added' THEN RAISE EXCEPTION 'synthetic_snapshot_link_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_snapshot_link_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_snapshot_link_audit_failure()",
  );
  try {
    await expect(ingest(ctx.tenantId, id, "# Refused snapshot content")).rejects.toThrow();
    expect(await source(ctx.tenantId, id)).toEqual(before);
    expect(await links(ctx.tenantId, id)).toEqual(beforeLinks);
    expect(
      await ctx.db
        .select()
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.tenant_id, ctx.tenantId),
            eq(knowledgeChunks.knowledge_source_id, id),
          ),
        ),
    ).toEqual(chunks);
    expect(
      await ctx.db
        .select()
        .from(knowledgeSourceVersions)
        .where(
          and(
            eq(knowledgeSourceVersions.tenant_id, ctx.tenantId),
            eq(knowledgeSourceVersions.knowledge_source_id, id),
          ),
        ),
    ).toEqual(versions);
  } finally {
    await ctx.testDb.pool.query(
      "DROP TRIGGER test_snapshot_link_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_snapshot_link_audit_failure()",
    );
  }
});

test("hosted snapshot history remains charged and full shared quota refuses another snapshot without changing current content", async () => {
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example",
      subject: uuid(),
      email: "snapshot-quota@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  const tenantId = owned.tenant.id;
  const id = await create(tenantId, "# Hosted original");
  await ingest(tenantId, id, "# Hosted replacement");
  const before = await source(tenantId, id);
  const [usage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!usage) throw new Error("snapshot_usage_fixture_missing");
  expect(usage.resource_counts.file_links).toBe("2");
  expect(usage.resource_counts.files).toBe("2");
  expect(usage.resource_counts.knowledge_source_versions).toBe("2");
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${usage.logical_bytes.toString()}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  try {
    let failure: unknown;
    try {
      await ingest(tenantId, id, "# Denied hosted snapshot");
    } catch (error) {
      failure = error;
    }
    expect(hostedQuotaError(failure)?.code).toBe("hosted_storage_quota_exhausted");
    expect(await source(tenantId, id)).toEqual(before);
    expect(await links(tenantId, id)).toHaveLength(2);
    const [after] = await ctx.db
      .select()
      .from(hostedTenantUsage)
      .where(eq(hostedTenantUsage.tenant_id, tenantId));
    expect(after?.logical_bytes).toBe(usage.logical_bytes);
  } finally {
    await ctx.db.execute(
      sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}','"50000000"'::jsonb) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
    );
  }
});
