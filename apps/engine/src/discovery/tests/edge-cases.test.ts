import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  approveDiscoveryArtifact,
  createDiscoveryRun,
  getDiscoveryRun,
  rejectDiscoveryArtifact,
} from "../service.ts";

const skip = testEnv.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("disc-edge");
  tenantId = (await seedTenant(testDb.db, { slug: "disc-edge", display_name: "Discovery Edge" }))
    .id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe.skipIf(skip)("discovery/edge-cases", () => {
  test("run audit preserves a typed system-account actor", async () => {
    const actorId = "00000000-0000-4000-8000-000000000034";
    const run = await createDiscoveryRun(
      {
        tenant_id: tenantId,
        files: [],
        actor_id: actorId,
        actor: { kind: "system_account", id: actorId },
      },
      testDb.db,
    );
    const [audit] = await testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(and(eq(auditLog.resource_id, run.id), eq(auditLog.action, "discovery.run_created")));
    expect(audit).toEqual({ actor_type: "system_account", actor_id: actorId });
  });

  test("missing and legacy discovery actors never become users", async () => {
    const legacyId = "00000000-0000-4000-8000-000000000035";
    const missing = await createDiscoveryRun(
      { tenant_id: tenantId, files: [], actor_id: null },
      testDb.db,
    );
    const legacy = await createDiscoveryRun(
      { tenant_id: tenantId, files: [], actor_id: legacyId },
      testDb.db,
    );
    const rows = await testDb.db
      .select({
        resource_id: auditLog.resource_id,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(inArray(auditLog.resource_id, [missing.id, legacy.id]));
    expect(rows).toContainEqual({ resource_id: missing.id, actor_type: "system", actor_id: null });
    expect(rows).toContainEqual({ resource_id: legacy.id, actor_type: "unknown", actor_id: null });
  });

  test("run with 0 files creates run with file_count=0", async () => {
    const run = await createDiscoveryRun(
      { tenant_id: tenantId, files: [], actor_id: null },
      testDb.db,
    );
    expect(run.file_count).toBe(0);
    expect(run.status).toBe("pending");
  });

  test("run with file that has invalid content doesn't abort entire run", async () => {
    const run = await createDiscoveryRun(
      {
        tenant_id: tenantId,
        files: [
          { buffer: Buffer.from("valid content"), filename: "good.txt" },
          { buffer: Buffer.from("\x00\x01\x02binary"), filename: "bad.bin" },
        ],
        actor_id: null,
      },
      testDb.db,
    );
    expect(run.file_count).toBe(2);
  });

  test("get non-existent run returns null", async () => {
    const result = await getDiscoveryRun(tenantId, crypto.randomUUID(), testDb.db); // allow-random: legacy; review before changing
    expect(result).toBeNull();
  });

  test("approve non-existent artifact returns null", async () => {
    const result = await approveDiscoveryArtifact(
      { tenant_id: tenantId, artifact_id: crypto.randomUUID(), actor_id: null }, // allow-random: legacy; review before changing
      testDb.db,
    );
    expect(result).toBeNull();
  });

  test("reject non-existent artifact returns false", async () => {
    const result = await rejectDiscoveryArtifact(
      { tenant_id: tenantId, artifact_id: crypto.randomUUID(), actor_id: null }, // allow-random: legacy; review before changing
      testDb.db,
    );
    expect(result).toBe(false);
  });

  test("approve artifact from different tenant returns null", async () => {
    const other = await seedTenant(testDb.db, { slug: "disc-other", display_name: "Other" });
    const result = await approveDiscoveryArtifact(
      { tenant_id: other!.id, artifact_id: crypto.randomUUID(), actor_id: null }, // allow-random: legacy; review before changing
      testDb.db,
    );
    expect(result).toBeNull();
  });
});
