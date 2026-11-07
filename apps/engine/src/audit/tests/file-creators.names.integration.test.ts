import { beforeAll, describe, expect, test } from "bun:test";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, systemAccounts, users } from "../../db/schema/identity.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { fileCreatorNames, recordedFileCreators } from "../file-creators.ts";
import { AuditAction } from "../types.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb } from "./contracts-fixtures.ts";

useAuditContractsDb();

const uuid = createDeterministicUuidFactory(0xf11e5);
const namedUser = uuid();
const blankUser = uuid();
const account = uuid();
const keyA = uuid();
const keyB = uuid();

async function created(
  fileId: string,
  kind: "user" | "system_account",
  actorId: string,
  metadata: Record<string, unknown>,
  tenant = tenantA,
) {
  await testDb.db.insert(auditLog).values({
    id: uuid(),
    ts: new Date(FROZEN_NOW),
    tenant_id: tenant,
    actor_type: kind,
    actor_id: actorId,
    action: AuditAction.FILE_CREATED,
    resource_type: "file",
    resource_id: fileId,
    result: "success",
    metadata,
  });
}

beforeAll(async () => {
  const roleA = await emptyRoleId(testDb.db, tenantA);
  await testDb.db.insert(users).values([
    {
      id: namedUser,
      tenant_id: tenantA,
      email: "named@example.com",
      display_name: "Ada",
      role_id: roleA,
    },
    {
      id: blankUser,
      tenant_id: tenantA,
      email: "blank@example.com",
      display_name: "",
      role_id: roleA,
    },
  ]);
  await testDb.db
    .insert(systemAccounts)
    .values({ id: account, tenant_id: tenantA, name: "ingest-bot" });
  await testDb.db.insert(apiKeys).values([
    {
      id: keyA,
      tenant_id: tenantA,
      prefix: "ska",
      token_sha256: "a".repeat(64),
      name: "ci key",
      scopes: [],
    },
    {
      id: keyB,
      tenant_id: tenantB,
      prefix: "skb",
      token_sha256: "b".repeat(64),
      name: "foreign key",
      scopes: [],
    },
  ]);
});

describe("fileCreatorNames", () => {
  test("no recorded creator yields no names", async () => {
    expect(await fileCreatorNames(testDb.db, tenantA, uuid(), null)).toEqual({
      name: null,
      api_key_name: null,
    });
  });

  test("a user creator is named by display name and by the API key recorded on creation", async () => {
    const fileId = uuid();
    await created(fileId, "user", namedUser, { dedup: false, audit_used_api_key_id: keyA });
    expect(
      await fileCreatorNames(testDb.db, tenantA, fileId, { kind: "user", id: namedUser }),
    ).toEqual({ name: "Ada", api_key_name: "ci key" });
  });

  test("an empty display name is reported as no name", async () => {
    const fileId = uuid();
    await created(fileId, "user", blankUser, { dedup: false });
    expect(
      await fileCreatorNames(testDb.db, tenantA, fileId, { kind: "user", id: blankUser }),
    ).toEqual({ name: null, api_key_name: null });
  });

  test("a system account creator is named by its account name", async () => {
    const fileId = uuid();
    await created(fileId, "system_account", account, { dedup: false });
    expect(
      await fileCreatorNames(testDb.db, tenantA, fileId, { kind: "system_account", id: account }),
    ).toEqual({ name: "ingest-bot", api_key_name: null });
  });

  test("an API key from another tenant or a deduplicated upload is never attributed", async () => {
    const foreign = uuid();
    await created(foreign, "user", namedUser, { dedup: false, audit_used_api_key_id: keyB });
    expect(
      (await fileCreatorNames(testDb.db, tenantA, foreign, { kind: "user", id: namedUser }))
        .api_key_name,
    ).toBeNull();
    const dedup = uuid();
    await created(dedup, "user", namedUser, { dedup: true, audit_used_api_key_id: keyA });
    expect(
      (await fileCreatorNames(testDb.db, tenantA, dedup, { kind: "user", id: namedUser }))
        .api_key_name,
    ).toBeNull();
  });

  test("the key recorded by a different actor is not attributed to this creator", async () => {
    const fileId = uuid();
    await created(fileId, "system_account", account, { dedup: false, audit_used_api_key_id: keyA });
    expect(
      await fileCreatorNames(testDb.db, tenantA, fileId, { kind: "user", id: namedUser }),
    ).toEqual({ name: "Ada", api_key_name: null });
  });

  test("another tenant cannot resolve this tenant's creator names", async () => {
    const fileId = uuid();
    await created(fileId, "user", namedUser, { dedup: false, audit_used_api_key_id: keyA });
    expect(
      await fileCreatorNames(testDb.db, tenantB, fileId, { kind: "user", id: namedUser }),
    ).toEqual({ name: null, api_key_name: null });
  });
});

describe("recordedFileCreators", () => {
  test("creation evidence from the recorded actor resolves the creator, per file", async () => {
    const userFile = uuid();
    const accountFile = uuid();
    await created(userFile, "user", namedUser, { dedup: false });
    await created(accountFile, "system_account", account, { dedup: false });
    const creators = await recordedFileCreators(testDb.db, tenantA, [
      { id: userFile, created_by: namedUser },
      { id: accountFile, created_by: account },
    ]);
    expect(creators.size).toBe(2);
    expect(creators.get(userFile)).toEqual({ kind: "user", id: namedUser });
    expect(creators.get(accountFile)).toEqual({ kind: "system_account", id: account });
  });

  test("a repeated creation record of the same kind still resolves", async () => {
    const fileId = uuid();
    await created(fileId, "user", namedUser, { dedup: false });
    await created(fileId, "user", namedUser, { dedup: false });
    const creators = await recordedFileCreators(testDb.db, tenantA, [
      { id: fileId, created_by: namedUser },
    ]);
    expect(creators.get(fileId)).toEqual({ kind: "user", id: namedUser });
  });

  test("an unknown actor type on the creation record is not trusted", async () => {
    const fileId = uuid();
    await testDb.db.insert(auditLog).values({
      id: uuid(),
      ts: new Date(FROZEN_NOW),
      tenant_id: tenantA,
      actor_type: "system",
      actor_id: namedUser,
      action: AuditAction.FILE_CREATED,
      resource_type: "file",
      resource_id: fileId,
      result: "success",
      metadata: { dedup: false },
    });
    const creators = await recordedFileCreators(testDb.db, tenantA, [
      { id: fileId, created_by: namedUser },
    ]);
    expect(creators.size).toBe(0);
  });
});
