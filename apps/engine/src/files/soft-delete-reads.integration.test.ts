import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { files, tenants } from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../storage/object-store.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { FileNotFoundError, resolveSingleFid, walkAndResolve } from "./resolver.ts";
import { deleteFile, findDownloadableFile, findLiveFile, getFileDetail } from "./service/index.ts";

const uuid = createDeterministicUuidFactory(0x512de1);
const store = new MemoryObjectStore();
let fixture: TestDb;

beforeAll(async () => {
  fixture = await createTestDb("file_soft_delete_reads");
  setObjectStoreForTesting(store);
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  setObjectStoreForTesting(null);
  if (fixture) await fixture.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function seedFile() {
  const tenantId = uuid();
  const fileId = uuid();
  await fixture.db
    .insert(tenants)
    .values({ id: tenantId, slug: tenantId, display_name: "Soft delete fixture" });
  await fixture.db.insert(files).values({
    id: fileId,
    tenant_id: tenantId,
    filename: "deleted.txt",
    status: "ready",
    storage_uri: `memory://${fileId}`,
    size_bytes: 4,
  });
  await store.put(fileId, new Uint8Array([1, 2, 3, 4]));
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "system_account",
    id: uuid(),
    tenant_id: tenantId,
    roles: [],
  };
  return { tenantId, fileId, actor: { principal, request_source: "api" as const } };
}

test("soft-deleted file is hidden from detail, download and workflow resolution (#512)", async () => {
  const { tenantId, fileId, actor } = await seedFile();
  expect(await findDownloadableFile(fixture.db, tenantId, fileId)).not.toBeNull();

  expect(await deleteFile(fixture.db, actor, fileId)).toBe("deleted");

  expect(await getFileDetail(fixture.db, actor.principal, fileId)).toBeNull();
  expect(await findDownloadableFile(fixture.db, tenantId, fileId)).toBeNull();
  expect(await findLiveFile(fixture.db, tenantId, fileId)).toBeNull();
  await expect(
    walkAndResolve({ $file: `fid_${fileId}` }, { db: fixture.db, tenant_id: tenantId }, new Map()),
  ).rejects.toBeInstanceOf(FileNotFoundError);
  await expect(resolveSingleFid(fixture.db, tenantId, `fid_${fileId}`)).rejects.toBeInstanceOf(
    FileNotFoundError,
  );
});

test("repeat delete of a soft-deleted file still reports deleted", async () => {
  const { fileId, actor } = await seedFile();
  expect(await deleteFile(fixture.db, actor, fileId)).toBe("deleted");
  expect(await deleteFile(fixture.db, actor, fileId)).toBe("deleted");
});
