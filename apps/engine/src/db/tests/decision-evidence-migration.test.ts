import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "../migrate.ts";
import { auditLog, skillCandidateEvidence, skillCandidates, tenants } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "./setup.ts";

test(
  "upgrade consolidates repeated evidence with audit and preserves completed decisions",
  async () => {
    const ctx = await createTestDb("decision_evidence_upgrade", { upToIdx: 58 });
    try {
      const [tenant] = await ctx.db
        .insert(tenants)
        .values({ slug: "evidence-upgrade", display_name: "Evidence upgrade" })
        .returning();
      if (!tenant) throw new Error("missing tenant");
      const [candidate] = await ctx.db
        .insert(skillCandidates)
        .values({
          tenant_id: tenant.id,
          scope: "global",
          pattern_kind: "session_learning",
          title: "Reviewed rule",
          body: "Retain this decision",
          evidence: [],
          status: "approved",
          confidence: "low",
          fingerprint: "migration-test",
        })
        .returning();
      if (!candidate) throw new Error("missing candidate");
      await ctx.db.insert(skillCandidateEvidence).values(
        Array.from({ length: 50 }, (_, index) => ({
          skill_candidate_id: candidate.id,
          evidence_type: "session_learning",
          summary: `Observation ${index % 3}`,
        })),
      );
      await runMigrations(ctx.db);
      const evidence = await ctx.db
        .select()
        .from(skillCandidateEvidence)
        .where(eq(skillCandidateEvidence.skill_candidate_id, candidate.id));
      expect(evidence).toHaveLength(3);
      const audit = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenant.id),
            eq(auditLog.resource_id, candidate.id),
            eq(auditLog.action, "skill_candidate.evidence_consolidated"),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ duplicates_removed: 47 });
      const [preserved] = await ctx.db
        .select()
        .from(skillCandidates)
        .where(and(eq(skillCandidates.tenant_id, tenant.id), eq(skillCandidates.id, candidate.id)));
      expect(preserved?.status).toBe("approved");
      expect((await runMigrations(ctx.db)).applied).toBe(0);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
