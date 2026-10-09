import { afterAll, beforeAll, expect, test } from "bun:test";
import { auditLog } from "../../db/schema/audit.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { recordedFileCreators } from "../file-creators.ts";
import { AuditAction } from "../types.ts";

const nextId = createDeterministicUuidFactory(0xf11ec);
const tenantId = nextId();
const otherTenant = nextId();
const actorId = nextId();
const otherActor = nextId();
const fileId = nextId();
const unknownId = nextId();
let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("file_creator_provenance");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function event(
  kind: "user" | "system_account",
  tenant = tenantId,
  dedup = false,
  actor = actorId,
) {
  await ctx.db.insert(auditLog).values({
    id: nextId(),
    ts: new Date(FROZEN_NOW),
    tenant_id: tenant,
    actor_type: kind,
    actor_id: actor,
    action: AuditAction.FILE_CREATED,
    resource_type: "file",
    resource_id: fileId,
    result: "success",
    metadata: { dedup },
  });
}

test("requires original creation evidence for the recorded actor in the same tenant", async () => {
  const files = [
    { id: fileId, created_by: actorId },
    { id: unknownId, created_by: actorId },
  ];
  await event("user", otherTenant);
  await event("user", tenantId, true);
  await event("user", tenantId, false, otherActor);
  expect(await recordedFileCreators(ctx.db, tenantId, files)).toEqual(new Map());
  await event("system_account");
  const creators = await recordedFileCreators(ctx.db, tenantId, files);
  expect(creators.get(fileId)).toEqual({ kind: "system_account", id: actorId });
  expect(creators.has(unknownId)).toBe(false);
  expect(await recordedFileCreators(ctx.db, tenantId, [{ id: fileId, created_by: null }])).toEqual(
    new Map(),
  );
  await event("user");
  expect(await recordedFileCreators(ctx.db, tenantId, files)).toEqual(new Map());
});
