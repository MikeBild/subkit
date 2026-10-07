import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skillCandidates, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { buildAttention, invalidateAttention } from "./attention.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("attention-learnings");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "attention-learnings", display_name: "Attention learnings" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenant_id = tenant.id;
  const proposal = {
    tenant_id,
    scope: "global" as const,
    body: "b",
    evidence: {},
    confidence: "high" as const,
    status: "proposed" as const,
  };
  await testDb.db.insert(skillCandidates).values([
    { ...proposal, title: "fact", pattern_kind: "knowledge_learning", fingerprint: "fp-fact" },
    {
      ...proposal,
      title: "practice",
      pattern_kind: "session_learning",
      fingerprint: "fp-practice",
    },
    { ...proposal, title: "pattern", pattern_kind: "success_pattern", fingerprint: "fp-pattern" },
  ]);
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

describe("attention — proposals from conversations", () => {
  test("all open proposals are one decide entry that says how many are facts", async () => {
    invalidateAttention(tenant_id);
    const attention = await buildAttention(testDb.db, adminPrincipal(tenant_id));
    const proposals = attention.items.filter((item) => item.reason === "skills_proposed");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      id: "skills",
      class: "decide",
      counts: { skills: 3, knowledge: 1 },
    });
  });
});
