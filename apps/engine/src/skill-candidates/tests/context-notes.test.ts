import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { tenants } from "../../db/schema/identity.ts";
import { skillCandidates, skills } from "../../db/schema/skills.ts";
import { workflows } from "../../db/schema/workflows.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  approveSkillCandidate,
  countSkillCandidates,
  rejectSkillCandidate,
  upsertFromSignal,
} from "../service.ts";
import type { PatternSignal } from "../types.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let workflowId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("skill-candidate-context-notes");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "ctx-notes-tenant", display_name: "Context notes" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  const [wf] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "ctx-wf", name: "Context", lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

function signal(pattern_kind: PatternSignal["pattern_kind"], fingerprint: string): PatternSignal {
  return {
    pattern_kind,
    scope: "workflow",
    workflow_id: workflowId,
    title: `${pattern_kind} note`,
    body: "Inputs: none declared.",
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    fingerprint,
    confidence: "high",
    evidence: [{ evidence_type: "workflow_committed", summary: `seen ${fingerprint}` }],
  };
}

describe.skipIf(skip)("drafting context notes", () => {
  for (const kind of ["authoring_capability", "failure_pattern"] as const) {
    test(`${kind} is recorded as context, audited as such, and never counted as a proposal`, async () => {
      const result = await upsertFromSignal(tenantId, signal(kind, `ctx-${kind}`), testDb.db);
      expect(result.action).toBe("recorded");
      const [row] = await testDb.db
        .select({ status: skillCandidates.status })
        .from(skillCandidates)
        .where(eq(skillCandidates.id, result.candidate_id!));
      expect(row?.status).toBe("context");
      const audits = await testDb.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(
          and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, result.candidate_id!)),
        );
      expect(audits.map((a) => a.action)).toEqual(["skill_candidate.context_recorded"]);
      expect(
        await countSkillCandidates(
          { tenant_id: tenantId, status: "proposed", pattern_kind: kind },
          testDb.db,
        ),
      ).toBe(0);
    });

    test(`${kind} cannot be approved or rejected and creates no skill`, async () => {
      const result = await upsertFromSignal(
        tenantId,
        signal(kind, `ctx-decide-${kind}`),
        testDb.db,
      );
      const id = result.candidate_id!;
      expect(
        await approveSkillCandidate(
          { tenant_id: tenantId, candidate_id: id, actor_id: null },
          testDb.db,
        ),
      ).toBeNull();
      expect(
        await rejectSkillCandidate(
          { tenant_id: tenantId, candidate_id: id, actor_id: null },
          testDb.db,
        ),
      ).toBe(false);
      const [after] = await testDb.db
        .select({ status: skillCandidates.status })
        .from(skillCandidates)
        .where(eq(skillCandidates.id, id));
      expect(after?.status).toBe("context");
      const created = await testDb.db.select().from(skills).where(eq(skills.tenant_id, tenantId));
      expect(created).toEqual([]);
    });
  }

  test("a real proposal is still recorded as proposed", async () => {
    const result = await upsertFromSignal(
      tenantId,
      signal("repair_pattern", "ctx-repair"),
      testDb.db,
    );
    expect(result.action).toBe("proposed");
    const [row] = await testDb.db
      .select({ status: skillCandidates.status })
      .from(skillCandidates)
      .where(eq(skillCandidates.id, result.candidate_id!));
    expect(row?.status).toBe("proposed");
  });
});
