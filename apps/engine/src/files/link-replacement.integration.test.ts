import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, fileLinks, files, tenants } from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { linkStoredFile, replaceStoredFileLink } from "./links.ts";

const uuid = createDeterministicUuidFactory(0x41e1ace);
const context = {
  actor_type: "system" as const,
  actor_id: null,
  request_source: "api" as const,
  allowed_statuses: ["ready"] as const,
};
let fixture: TestDb;
beforeAll(async () => {
  fixture = await createTestDb("file_link_replacement");
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  if (fixture) await fixture.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function linkedFiles() {
  const tenantId = uuid();
  const originalId = uuid();
  const replacementId = uuid();
  await fixture.db.insert(tenants).values({
    id: tenantId,
    slug: tenantId,
    display_name: "File replacement fixture",
  });
  await fixture.db.insert(files).values(
    [originalId, replacementId].map((id) => ({
      id,
      tenant_id: tenantId,
      filename: "fixture.txt",
      status: "ready" as const,
      storage_uri: `memory://${id}`,
    })),
  );
  const input = {
    tenant_id: tenantId,
    file_id: originalId,
    resource_type: "knowledge_source" as const,
    resource_id: uuid(),
    slug: "source",
    role: "source",
  };
  await linkStoredFile(fixture.db, input, context);
  return { input, replacementId };
}

test("replacement requires the exact old file and audits both link changes", async () => {
  const { input, replacementId } = await linkedFiles();
  const next = { ...input, file_id: replacementId };
  await expect(
    linkStoredFile(fixture.db, next, { ...context, replace_file_id: uuid() }),
  ).rejects.toMatchObject({ code: "file_link_conflict" });
  const changed = await linkStoredFile(fixture.db, next, {
    ...context,
    replace_file_id: input.file_id,
  });
  expect(changed.file_id).toBe(replacementId);
  const links = await fixture.db
    .select()
    .from(fileLinks)
    .where(eq(fileLinks.tenant_id, input.tenant_id));
  expect(links).toHaveLength(1);
  expect(links[0]?.file_id).toBe(replacementId);
  const audits = await fixture.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenant_id, input.tenant_id));
  expect(audits.filter((row) => row.action === "file.link_added")).toHaveLength(2);
  expect(audits.find((row) => row.action === "file.link_removed")?.resource_id).toBe(input.file_id);
  await expect(
    linkStoredFile(fixture.db, input, { ...context, replace_file_id: input.file_id }),
  ).rejects.toMatchObject({ code: "file_link_conflict" });
});

test("replacement audit failure restores the old link atomically", async () => {
  const { input, replacementId } = await linkedFiles();
  await fixture.pool.query(
    "CREATE FUNCTION subkit.test_replacement_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='file.link_added' THEN RAISE EXCEPTION 'synthetic_replacement_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_replacement_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_replacement_audit_failure()",
  );
  try {
    await expect(
      linkStoredFile(
        fixture.db,
        { ...input, file_id: replacementId },
        {
          ...context,
          replace_file_id: input.file_id,
        },
      ),
    ).rejects.toThrow();
    const links = await fixture.db
      .select()
      .from(fileLinks)
      .where(eq(fileLinks.tenant_id, input.tenant_id));
    expect(links).toHaveLength(1);
    expect(links[0]?.file_id).toBe(input.file_id);
    expect(
      await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.tenant_id, input.tenant_id), eq(auditLog.action, "file.link_removed")),
        ),
    ).toHaveLength(0);
  } finally {
    await fixture.pool.query(
      "DROP TRIGGER test_replacement_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_replacement_audit_failure()",
    );
  }
});

test("resource replacement refuses a foreign file and retains the existing link", async () => {
  const { input } = await linkedFiles();
  const other = await linkedFiles();
  await expect(
    replaceStoredFileLink(fixture.db, { ...input, file_id: other.replacementId }, context),
  ).rejects.toMatchObject({ code: "file_unavailable" });
  const links = await fixture.db
    .select()
    .from(fileLinks)
    .where(eq(fileLinks.tenant_id, input.tenant_id));
  expect(links).toHaveLength(1);
  expect(links[0]?.file_id).toBe(input.file_id);
});

test("replacing one source retains another source's link to the shared original file", async () => {
  const { input, replacementId } = await linkedFiles();
  const otherResourceId = uuid();
  await linkStoredFile(fixture.db, { ...input, resource_id: otherResourceId }, context);
  await replaceStoredFileLink(fixture.db, { ...input, file_id: replacementId }, context);
  const links = await fixture.db
    .select()
    .from(fileLinks)
    .where(eq(fileLinks.tenant_id, input.tenant_id));
  expect(links).toHaveLength(2);
  expect(links.find((row) => row.resource_id === input.resource_id)?.file_id).toBe(replacementId);
  expect(links.find((row) => row.resource_id === otherResourceId)?.file_id).toBe(input.file_id);
});
