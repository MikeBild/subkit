import { expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { runMigrations } from "../migrate.ts";
import { auditLog, skillCandidateEvidence, skillCandidates } from "../schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "./setup.ts";

test(
  "upgrade consolidates repeated evidence with audit and preserves completed decisions",
  async () => {
    const ctx = await createTestDb("decision_evidence_upgrade", { upToIdx: 58 });
    try {
      const tenantRows = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO tenants (slug, display_name)
        VALUES ('evidence-upgrade', 'Evidence upgrade')
        RETURNING id
      `);
      const tenant = tenantRows.rows[0];
      if (!tenant) throw new Error("missing tenant");
      const candidateRows = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO skill_candidates
          (tenant_id, scope, pattern_kind, title, body, evidence, status, confidence, fingerprint)
        VALUES
          (${tenant.id}, 'global', 'session_learning', 'Reviewed rule', 'Retain this decision',
           '[]'::jsonb, 'approved', 'low', 'migration-test')
        RETURNING id
      `);
      const candidate = candidateRows.rows[0];
      if (!candidate) throw new Error("missing candidate");
      for (let index = 0; index < 50; index += 1) {
        await ctx.db.execute(sql`
          INSERT INTO skill_candidate_evidence (skill_candidate_id, evidence_type, summary)
          VALUES (${candidate.id}, 'session_learning', ${`Observation ${index % 3}`})
        `);
      }
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
