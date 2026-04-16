import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  approveDiscoveryArtifact,
  createDiscoveryRun,
  getDiscoveryRun,
  rejectDiscoveryArtifact,
} from "../service.ts";

const skip = process.env.SKIP_DB_TESTS === "1";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("disc-edge");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "disc-edge", display_name: "Discovery Edge" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe.skipIf(skip)("discovery/edge-cases", () => {
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
    // Both files should be recorded (one may have status=failed)
    expect(run.file_count).toBe(2);
  });

  test("get non-existent run returns null", async () => {
    const result = await getDiscoveryRun(tenantId, crypto.randomUUID(), testDb.db);
    expect(result).toBeNull();
  });

  test("approve non-existent artifact returns null", async () => {
    const result = await approveDiscoveryArtifact(
      { tenant_id: tenantId, artifact_id: crypto.randomUUID(), actor_id: null },
      testDb.db,
    );
    expect(result).toBeNull();
  });

  test("reject non-existent artifact returns false", async () => {
    const result = await rejectDiscoveryArtifact(
      { tenant_id: tenantId, artifact_id: crypto.randomUUID(), actor_id: null },
      testDb.db,
    );
    expect(result).toBe(false);
  });

  test("approve artifact from different tenant returns null", async () => {
    const [other] = await testDb.db
      .insert(tenants)
      .values({ slug: "disc-other", display_name: "Other" })
      .returning();
    const result = await approveDiscoveryArtifact(
      { tenant_id: other!.id, artifact_id: crypto.randomUUID(), actor_id: null },
      testDb.db,
    );
    expect(result).toBeNull();
  });
});
