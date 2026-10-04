import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { proposeLearning } from "../../agent/sessions.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { deleteSkill, getSkill } from "../../skills/service.ts";
import {
  approveSkillCandidate,
  getSkillCandidate,
  getSkillCandidateEvidence,
  listSkillCandidates,
  rejectSkillCandidate,
} from "../service.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let db: Db;

function propose(title: string, overrides: { domains?: string[]; body?: string } = {}) {
  return proposeLearning({
    tenant_id: tenantId,
    title,
    body: overrides.body ?? `Body of ${title}`,
    domains: overrides.domains ?? ["blog-de"],
    confidence: "high",
    evidence_summary: "agent=claude-code session=test",
    db,
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("session-learning");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "session-learning", display_name: "Session Learning" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe.skipIf(skip)("session_learning capture loop", () => {
  test("proposes with domain tags and stays proposed", async () => {
    const result = await propose("Halbgeviertstrich als Gedankenstrich");
    expect(result.action).toBe("proposed");
    const candidate = await getSkillCandidate(tenantId, result.candidate_id ?? "", db);
    expect(candidate?.status).toBe("proposed");
    expect(candidate?.pattern_kind).toBe("session_learning");
    expect(candidate?.tags).toEqual(["domain:blog-de"]);
  });

  test("re-proposing the same title dedups into an update, reworded case included", async () => {
    const first = await propose("Keine ASCII-Umlaute im Fließtext");
    expect(first.action).toBe("proposed");
    const second = await propose("keine ascii-umlaute  im fließtext");
    expect(second.action).toBe("updated");
    expect(second.candidate_id).toBe(first.candidate_id);
  });

  test("distinct learnings COEXIST — a new one never supersedes the queue", async () => {
    await propose("Lernpunkt A");
    await propose("Lernpunkt B");
    const items = await listSkillCandidates(
      { tenant_id: tenantId, status: "proposed", pattern_kind: "session_learning" },
      db,
    );
    const titles = items.map((c) => c.title);
    expect(titles).toContain("Lernpunkt A");
    expect(titles).toContain("Lernpunkt B");
    expect(titles).toContain("Halbgeviertstrich als Gedankenstrich");
  });

  test("a rejected learning is never re-proposed", async () => {
    const first = await propose("Verworfene Regel");
    expect(first.action).toBe("proposed");
    const rejected = await rejectSkillCandidate(
      { tenant_id: tenantId, candidate_id: first.candidate_id ?? "", actor_id: null },
      db,
    );
    expect(rejected).toBe(true);
    const again = await propose("Verworfene Regel");
    expect(again.action).toBe("skipped");
  });

  test("deleting a promoted skill nulls the candidate reference instead of failing", async () => {
    const proposal = await propose("Löschbare Regel");
    const approved = await approveSkillCandidate(
      { tenant_id: tenantId, candidate_id: proposal.candidate_id ?? "", actor_id: null },
      db,
    );
    if (!approved) throw new Error("approve failed");
    const deleted = await deleteSkill(tenantId, approved.skill_id, null, db);
    expect(deleted).toBe(true);
    const candidate = await getSkillCandidate(tenantId, proposal.candidate_id ?? "", db);
    expect(candidate?.status).toBe("approved");
    expect(candidate?.promoted_skill_id).toBeNull();
  });

  test("approve promotes to a skill carrying the domain tags", async () => {
    const proposal = await propose("Approve-Regel", { domains: ["blog-de", "infra"] });
    const approved = await approveSkillCandidate(
      {
        tenant_id: tenantId,
        candidate_id: proposal.candidate_id ?? "",
        actor_id: null,
        overrides: { status: "active" },
      },
      db,
    );
    expect(approved).not.toBeNull();
    const skill = await getSkill(tenantId, approved?.skill_id ?? "", db);
    expect(skill?.status).toBe("active");
    expect(skill?.tags?.sort()).toEqual(["domain:blog-de", "domain:infra"]);
    expect(skill?.source).toBe("candidate");
  });
  test("repeated observations retain one evidence row and approval cannot duplicate active knowledge", async () => {
    const first = await propose("Concurrent reviewed rule");
    for (let i = 0; i < 5; i++) await propose("Concurrent reviewed rule");
    const candidateId = first.candidate_id ?? "";
    const candidate = await getSkillCandidate(tenantId, candidateId, db);
    expect(candidate?.evidence_count).toBe(1);
    expect(await getSkillCandidateEvidence(tenantId, candidateId, db)).toHaveLength(1);
    if (!candidate?.review_digest) throw new Error("missing review digest");
    const params = {
      tenant_id: tenantId,
      candidate_id: candidateId,
      actor_id: null,
      expected_review_digest: candidate.review_digest,
      overrides: { status: "active" as const },
    };
    expect(
      await approveSkillCandidate({ ...params, expected_review_digest: "0".repeat(64) }, db),
    ).toBeNull();
    const results = await Promise.all([
      approveSkillCandidate(params, db),
      approveSkillCandidate(params, db),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const approved = results.find(Boolean);
    const skill = await getSkill(tenantId, approved?.skill_id ?? "", db);
    expect(skill?.status).toBe("active");
    expect((await propose("Concurrent reviewed rule")).action).toBe("skipped");
  });
});
