import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { intakeItems, skillCandidates } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { buildAttention, invalidateAttention } from "./attention.ts";
import { attentionLine } from "./health-digest.ts";

let testDb: TestDb;
let tenant_id: string;

function collected(title: string, state: "collected" | "reviewing" | "discarded", n: number) {
  return {
    tenant_id,
    category: "blog-de",
    client_request_id: `00000000-0000-4000-8000-00000000c0${String(n).padStart(2, "0")}`,
    creation_request_digest: "seed",
    original_snapshot: {
      title,
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Body",
      origin: "session" as const,
      agent: "claude-code",
      session_id: `session-${n}`,
      repo: null,
      domains: ["blog-de"],
      evidence_excerpt: "quote",
    },
    title,
    body: "Body",
    state,
    collected_by_type: "system_account",
    collected_by_id: "00000000-0000-4000-8000-00000000c100",
  };
}

beforeAll(async () => {
  testDb = await createTestDb("attention-intake");
  tenant_id = (
    await seedTenant(testDb.db, { slug: "attention-intake", display_name: "Attention intake" })
  ).id;
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
  await testDb.db
    .insert(intakeItems)
    .values([
      collected("first", "collected", 1),
      collected("second", "reviewing", 2),
      collected("third", "discarded", 3),
    ]);
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

describe("attention — detected proposals and collected intake", () => {
  test("skill proposals count only detected patterns and intake counts what awaits review", async () => {
    invalidateAttention(tenant_id);
    const attention = await buildAttention(testDb.db, adminPrincipal(tenant_id));
    const proposals = attention.items.filter((item) => item.reason === "skills_proposed");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: "skills", class: "decide", counts: { skills: 1 } });
    const intake = attention.items.filter((item) => item.reason === "intake_collected");
    expect(intake).toHaveLength(1);
    expect(intake[0]).toMatchObject({
      id: "intake",
      class: "decide",
      counts: { intake: 2, intake_by_category: [{ category: "blog-de", count: 2 }] },
      actions: [
        { verb: "review", href: "/cockpit/intake?category=all", permission: "intake:read" },
      ],
    });
    expect(attention.sources.intake).toBe("answered");
    const entry = intake[0];
    if (!entry) throw new Error("missing intake attention entry");
    expect(attentionLine(entry)).toBe(
      "- [decide] intake_items: intake collected (2 collected items to review, by category: blog-de 2)",
    );
  });
});
