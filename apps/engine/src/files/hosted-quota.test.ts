import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../config/loader.ts";
import { files, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../storage/object-store.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { HostedFileQuotaError } from "./hosted-quota.ts";
import { persistInlineUpload } from "./persist-inline-upload.ts";
import { removeStoredFile } from "./remove-stored-file.ts";
import { insertFileRow, reviveFileRow } from "./slug.ts";

let tdb: TestDb;
let configDir: string;
let sequence = 0;
const store = new MemoryObjectStore();
beforeAll(async () => {
  tdb = await createTestDb("hosted-file-quota");
  configDir = mkdtempSync(join(tmpdir(), "sk-hosted-file-quota-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: tdb.url, NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  await configureHostedPolicyForTests(tdb.db, tdb.url);
  await setConfigKey("storage.hosted.tenant_bytes", "10");
  await setConfigKey("storage.hosted.max_file_bytes", "6");
  setObjectStoreForTesting(store);
});
afterAll(async () => {
  setObjectStoreForTesting(null);
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  await tdb.cleanup();
});
async function fixture() {
  sequence += 1;
  return (
    await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example.test",
        subject: `files-${sequence}`,
        email: `files-${sequence}@example.test`,
        email_verified: true,
      },
      TEST_WORKSPACE_REGISTRATION,
      tdb.db,
    )
  ).tenant.id;
}
function insert(tenantId: string, name: string, size = 6) {
  return insertFileRow(tdb.db, {
    tenant_id: tenantId,
    filename: name,
    size_bytes: size,
    storage_uri: `s3://fixture/${tenantId}/${name}`,
    status: "pending",
  });
}

test("parallel admission cannot overdraw one tenant and another tenant keeps its own allowance", async () => {
  const tenant = await fixture();
  const outcomes = await Promise.allSettled([insert(tenant, "first"), insert(tenant, "second")]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  const other = await fixture();
  await expect(insert(other, "independent")).resolves.toBeDefined();
});

test("per-file limit and missing quota fail closed before any row is created", async () => {
  const tenant = await fixture();
  await expect(insert(tenant, "oversized", 7)).rejects.toBeInstanceOf(HostedFileQuotaError);
  await setConfigKey("storage.hosted.tenant_bytes", "0");
  await expect(insert(tenant, "disabled")).rejects.toBeInstanceOf(HostedFileQuotaError);
  await setConfigKey("storage.hosted.tenant_bytes", "10");
  expect(await tdb.db.select().from(files).where(eq(files.tenant_id, tenant))).toHaveLength(0);
});

test("soft-deleted and failed files remain charged and revive consumes no extra bytes", async () => {
  const tenant = await fixture();
  const row = await insert(tenant, "retained");
  await store.put(`${tenant}/retained`, new Uint8Array(6));
  const [deleted] = await tdb.db
    .update(files)
    .set({ deleted_at: new Date(FROZEN_NOW), status: "failed" })
    .where(eq(files.id, row.id))
    .returning();
  if (!deleted) throw new Error("retained fixture missing");
  await expect(insert(tenant, "over-limit")).rejects.toBeInstanceOf(HostedFileQuotaError);
  expect((await reviveFileRow(tdb.db, deleted)).id).toBe(row.id);
  expect(await tdb.db.select().from(files).where(eq(files.tenant_id, tenant))).toHaveLength(1);
});

test("identical inline content is deduplicated without creating another reservation", async () => {
  const tenant = await fixture();
  const input = {
    tenant_id: tenant,
    actor_id: null,
    filename: "same",
    content_type: "text/plain",
    bytes: new TextEncoder().encode("same!!"),
  };
  const first = await persistInlineUpload(tdb.db, input);
  const second = await persistInlineUpload(tdb.db, input);
  expect(first.dedup).toBe(false);
  expect(second.dedup).toBe(true);
  expect(second.row.id).toBe(first.row.id);
  expect(await tdb.db.select().from(files).where(eq(files.tenant_id, tenant))).toHaveLength(1);
});

test("failed or unverified object cleanup retains the reservation; verified cleanup releases it", async () => {
  const tenant = await fixture();
  const row = await insert(tenant, "cleanup");
  const key = `${tenant}/cleanup`;
  await store.put(key, new Uint8Array(6));
  const deletion = spyOn(store, "delete").mockRejectedValueOnce(new Error("store unavailable"));
  await expect(removeStoredFile(tdb.db, tenant, row.id)).rejects.toThrow("store unavailable");
  deletion.mockImplementationOnce(async () => {});
  await expect(removeStoredFile(tdb.db, tenant, row.id)).rejects.toThrow("could not be verified");
  deletion.mockRestore();
  await expect(insert(tenant, "still-full")).rejects.toBeInstanceOf(HostedFileQuotaError);
  await removeStoredFile(tdb.db, tenant, row.id);
  await expect(insert(tenant, "released")).resolves.toBeDefined();
});

test("a concurrent revive cannot resurrect a row while its object is being removed", async () => {
  const tenant = await fixture();
  const row = await insert(tenant, "race-cleanup");
  const [retained] = await tdb.db
    .update(files)
    .set({ deleted_at: new Date(FROZEN_NOW) })
    .where(eq(files.id, row.id))
    .returning();
  if (!retained) throw new Error("retained fixture missing");
  await store.put(`${tenant}/race-cleanup`, new Uint8Array(6));
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const remove = store.delete.bind(store);
  const deletion = spyOn(store, "delete").mockImplementation(async (key) => {
    entered.resolve();
    await proceed.promise;
    await remove(key);
  });
  const removing = removeStoredFile(tdb.db, tenant, row.id, isNotNull(files.deleted_at));
  await entered.promise;
  const reviving = reviveFileRow(tdb.db, retained);
  proceed.resolve();
  const outcomes = await Promise.allSettled([removing, reviving]);
  deletion.mockRestore();
  expect(outcomes[0]?.status).toBe("fulfilled");
  expect(outcomes[1]?.status).toBe("rejected");
  expect(await store.head(`${tenant}/race-cleanup`)).toBeNull();
});

test("cleanup rechecks eligibility after a concurrent revive commits", async () => {
  const tenant = await fixture();
  const row = await insert(tenant, "race-revive");
  const [retained] = await tdb.db
    .update(files)
    .set({ deleted_at: new Date(FROZEN_NOW) })
    .where(eq(files.id, row.id))
    .returning();
  if (!retained) throw new Error("retained fixture missing");
  await store.put(`${tenant}/race-revive`, new Uint8Array(6));
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const reviving = tdb.db.transaction(async (tx) => {
    await reviveFileRow(tx, retained);
    entered.resolve();
    await proceed.promise;
  });
  await entered.promise;
  const removing = removeStoredFile(tdb.db, tenant, row.id, isNotNull(files.deleted_at));
  proceed.resolve();
  const [, removed] = await Promise.all([reviving, removing]);
  expect(removed).toBeUndefined();
  expect(await store.head(`${tenant}/race-revive`)).not.toBeNull();
});

test("self-hosted file behavior does not require hosted quota configuration", async () => {
  const [tenant] = await tdb.db
    .insert(tenants)
    .values({ slug: "ordinary-storage", display_name: "Ordinary" })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  await expect(insert(tenant.id, "large", 1000)).resolves.toBeDefined();
});
