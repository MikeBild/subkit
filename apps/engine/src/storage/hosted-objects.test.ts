import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setConfigKey } from "../config/loader.ts";
import { hostedQuotaError } from "../db/hosted-quota-errors.ts";
import {
  authIdentities,
  hostedStorageObjects,
  hostedTenantUsage,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { maybeOffload, resolveOffloaded } from "../execution/offload.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import {
  assertHostedObjectNamespace,
  deleteRetainedHostedObject,
  reserveHostedObject,
  retainHostedObject,
} from "./hosted-objects.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "./object-store.ts";

const nextUuid = createDeterministicUuidFactory(77193);
let database: TestDb;
beforeAll(async () => {
  database = await createTestDb("hosted-objects");
  await configureHostedPolicyForTests(database.db, database.url);
  await setConfigKey("storage.object_store.bucket", "objects-test", { force: true });
});
afterAll(async () => {
  setObjectStoreForTesting(null);
  if (database) await database.cleanup();
});
async function tenant() {
  const id = nextUuid();
  const [identity] = await database.db
    .insert(authIdentities)
    .values({
      issuer_url: "https://objects.example.test",
      subject: id,
      email: `${id}@example.test`,
    })
    .returning();
  const [row] = await database.db
    .insert(tenants)
    .values({
      slug: id,
      display_name: "Objects",
      origin: "self_service",
      owner_identity_id: identity!.id,
    })
    .returning();
  return row!.id;
}
function key(tenantId: string) {
  return `offload/${tenantId}/${nextUuid()}.json`;
}
async function rows(tenantId: string) {
  return database.db
    .select()
    .from(hostedStorageObjects)
    .where(eq(hostedStorageObjects.tenant_id, tenantId));
}

test("aggregate reservation rejects the next object before any object PUT", async () => {
  const tenantId = await tenant();
  await reserveHostedObject(database.db, tenantId, key(tenantId), 49_000_000);
  let puts = 0;
  class Store extends MemoryObjectStore {
    override async put() {
      puts += 1;
    }
  }
  setObjectStoreForTesting(new Store());
  let failure: unknown;
  try {
    await maybeOffload(database.db, {
      tenant_id: tenantId,
      execution_id: nextUuid(),
      result: "x".repeat(2_000_000),
    });
  } catch (error) {
    failure = error;
  }
  expect(hostedQuotaError(failure)?.code).toBe("hosted_storage_quota_exhausted");
  expect(puts).toBe(0);
  expect(await rows(tenantId)).toHaveLength(1);
});

test("unknown PUT failure retains its committed charged pending reservation", async () => {
  const tenantId = await tenant();
  class Store extends MemoryObjectStore {
    override async put() {
      throw new Error("unknown_remote_result");
    }
  }
  const objects = new Store();
  setObjectStoreForTesting(objects);
  await expect(
    maybeOffload(database.db, {
      tenant_id: tenantId,
      execution_id: nextUuid(),
      result: "x".repeat(20_000),
    }),
  ).rejects.toThrow("unknown_remote_result");
  const [row] = await rows(tenantId);
  expect(row?.state).toBe("pending");
  expect(row?.declared_bytes).toBe(20_002n);
  await expect(deleteRetainedHostedObject(database.db, tenantId, row!.id, objects)).rejects.toThrow(
    "object_upload_reconciliation_required",
  );
  await expect(
    database.db.delete(hostedStorageObjects).where(eq(hostedStorageObjects.id, row!.id)).execute(),
  ).rejects.toThrow();
  expect(await rows(tenantId)).toHaveLength(1);
});

test("verified retained object removal releases bytes and preserves other tenants", async () => {
  const tenantId = await tenant();
  const otherId = await tenant();
  const objectKey = key(tenantId);
  const otherKey = key(otherId);
  const objects = new MemoryObjectStore();
  const reservation = await reserveHostedObject(database.db, tenantId, objectKey, 49_000_000);
  const other = await reserveHostedObject(database.db, otherId, otherKey, 10);
  await objects.put(objectKey, Buffer.from("stored"));
  await objects.put(otherKey, Buffer.from("other"));
  await retainHostedObject(database.db, tenantId, reservation!);
  await retainHostedObject(database.db, otherId, other!);
  await deleteRetainedHostedObject(database.db, tenantId, reservation!, objects);
  await deleteRetainedHostedObject(database.db, tenantId, reservation!, objects);
  expect(await rows(tenantId)).toHaveLength(0);
  expect(await objects.head(otherKey)).not.toBeNull();
  expect(await rows(otherId)).toHaveLength(1);
  await reserveHostedObject(database.db, tenantId, key(tenantId), 49_000_000);
});

test("failed physical deletion and a changed store namespace cannot release usage", async () => {
  const tenantId = await tenant();
  const objectKey = key(tenantId);
  const reservation = await reserveHostedObject(database.db, tenantId, objectKey, 100);
  class Store extends MemoryObjectStore {
    override async delete() {}
  }
  const objects = new Store();
  await objects.put(objectKey, Buffer.from("retained"));
  await retainHostedObject(database.db, tenantId, reservation!);
  await expect(
    deleteRetainedHostedObject(database.db, tenantId, reservation!, objects),
  ).rejects.toThrow("object_absence_not_verified");
  expect((await rows(tenantId))[0]?.state).toBe("retained");
  await setConfigKey("storage.object_store.bucket", "different-test", { force: true });
  try {
    await expect(assertHostedObjectNamespace(tenantId, database.db)).rejects.toThrow(
      "object_storage_namespace_changed",
    );
    await expect(
      deleteRetainedHostedObject(database.db, tenantId, reservation!, objects),
    ).rejects.toThrow("object_storage_namespace_changed");
  } finally {
    await setConfigKey("storage.object_store.bucket", "objects-test", { force: true });
  }
  expect(await rows(tenantId)).toHaveLength(1);
});

test("direct SQL cannot resize or move a charged object reservation", async () => {
  const tenantId = await tenant();
  const reservation = await reserveHostedObject(database.db, tenantId, key(tenantId), 100);
  for (const patch of [
    { declared_bytes: 1n },
    { storage_key: key(tenantId) },
    { storage_namespace: "0".repeat(64) },
  ]) {
    await expect(
      database.db
        .update(hostedStorageObjects)
        .set(patch)
        .where(eq(hostedStorageObjects.id, reservation!))
        .execute(),
    ).rejects.toThrow();
  }
  expect((await rows(tenantId))[0]?.declared_bytes).toBe(100n);
});

test("concurrent offload reservations cannot exceed the shared tenant allowance", async () => {
  const tenantId = await tenant();
  const result = await Promise.allSettled([
    reserveHostedObject(database.db, tenantId, key(tenantId), 30_000_000),
    reserveHostedObject(database.db, tenantId, key(tenantId), 30_000_000),
  ]);
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const retained = await rows(tenantId);
  expect(retained).toHaveLength(1);
  expect(retained[0]!.declared_bytes).toBe(30_000_000n);
});

test("a completely reserved allowance still permits finalization and verified removal", async () => {
  const tenantId = await tenant();
  const [usage] = await database.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  const remaining = Number(50_000_000n - usage!.logical_bytes);
  const objectKey = key(tenantId);
  const reservation = await reserveHostedObject(database.db, tenantId, objectKey, remaining);
  const objects = new MemoryObjectStore();
  await objects.put(objectKey, Buffer.from("stored"));
  await retainHostedObject(database.db, tenantId, reservation!);
  await deleteRetainedHostedObject(database.db, tenantId, reservation!, objects);
  expect(await rows(tenantId)).toHaveLength(0);
});

test("forged offload references cannot read another tenant or unreserved Hosted object", async () => {
  const tenantId = await tenant();
  const otherId = await tenant();
  const otherKey = key(otherId);
  const unreserved = key(tenantId);
  let reads = 0;
  class Store extends MemoryObjectStore {
    override async get(objectKey: string) {
      reads += 1;
      return super.get(objectKey);
    }
  }
  const objects = new Store();
  setObjectStoreForTesting(objects);
  await objects.put(otherKey, Buffer.from('"other"'));
  await objects.put(unreserved, Buffer.from('"unreserved"'));
  for (const objectKey of [otherKey, unreserved]) {
    await expect(
      resolveOffloaded(database.db, tenantId, {
        $offloaded: true,
        storage_uri: `s3://objects-test/${objectKey}`,
        preview: "",
        size_bytes: 10,
      }),
    ).rejects.toThrow();
  }
  expect(reads).toBe(0);
});
