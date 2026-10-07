import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  approveSkillCandidate,
  getSkillCandidate,
  listSkillCandidates,
  rejectSkillCandidate,
} from "../service.ts";
import { computeConfidence } from "../types.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("sc-edge");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "sc-edge", display_name: "SC Edge" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe("skill-candidates/edge-cases (unit)", () => {
  test("computeConfidence with 0 evidence returns low", () => {
    expect(computeConfidence(0, 0)).toBe("low");
  });

  test("computeConfidence with 2 patches (below threshold) returns low", () => {
    expect(computeConfidence(2, 1.0)).toBe("low");
  });

  test("computeConfidence with exactly 3 patches returns low", () => {
    expect(computeConfidence(3, 0.9)).toBe("low");
  });

  test("computeConfidence boundary: 5 at 0.8 is medium", () => {
    expect(computeConfidence(5, 0.8)).toBe("medium");
  });

  test("computeConfidence boundary: 8 at 0.9 is high", () => {
    expect(computeConfidence(8, 0.9)).toBe("high");
  });
});

describe.skipIf(skip)("skill-candidates/edge-cases (db)", () => {
  test("approve non-existent candidate returns null", async () => {
    const result = await approveSkillCandidate(
      {
        tenant_id: tenantId,
        candidate_id: crypto.randomUUID(), // allow-random: legacy; review before changing
        actor: null,
        may_write_knowledge: false,
      },
      testDb.db,
    );
    expect(result).toBeNull();
  });

  test("approve candidate from different tenant returns null", async () => {
    const [other] = await testDb.db
      .insert(tenants)
      .values({ slug: "sc-other", display_name: "Other" })
      .returning();
    const result = await approveSkillCandidate(
      {
        tenant_id: other!.id,
        candidate_id: crypto.randomUUID(), // allow-random: legacy; review before changing
        actor: null,
        may_write_knowledge: false,
      },
      testDb.db,
    );
    expect(result).toBeNull();
  });

  test("reject non-existent candidate returns false", async () => {
    const result = await rejectSkillCandidate(
      {
        tenant_id: tenantId,
        candidate_id: crypto.randomUUID(), // allow-random: legacy; review before changing
        actor_id: null,
      },
      testDb.db,
    );
    expect(result).toBe(false);
  });

  test("list with no candidates returns empty array", async () => {
    const items = await listSkillCandidates({ tenant_id: tenantId }, testDb.db);
    expect(items).toEqual([]);
  });

  test("get non-existent candidate returns null", async () => {
    const result = await getSkillCandidate(tenantId, crypto.randomUUID(), testDb.db); // allow-random: legacy; review before changing
    expect(result).toBeNull();
  });
});
