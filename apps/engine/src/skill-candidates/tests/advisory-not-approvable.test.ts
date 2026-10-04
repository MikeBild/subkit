// An advisory candidate is never adopted, on any surface.
//
// The view marks authoring capabilities and failure patterns not reviewable
// and the Cockpit hides their action; the HTTP route, the CLI and the chat
// tool all reach `approveSkillCandidate`, so the rule lives there.
//
// Requires a real Postgres database — set REQUIRES_PG=0 to skip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/identity.ts";
import { skillCandidates, skills } from "../../db/schema/skills.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { AdvisoryCandidateError } from "../candidate-view.ts";
import { approveSkillCandidate } from "../service.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("advisory-not-approvable");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "anp-tenant", display_name: "ANP Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

async function seed(pattern_kind: "authoring_capability" | "failure_pattern") {
  const [row] = await testDb.db
    .insert(skillCandidates)
    .values({
      tenant_id: tenantId,
      scope: "global",
      pattern_kind,
      title: `advisory ${pattern_kind}`,
      body: "Inputs: none declared.",
      evidence: {},
      confidence: "low",
      fingerprint: `anp-${pattern_kind}`,
    })
    .returning();
  if (!row) throw new Error("seed candidate failed");
  return row;
}

describe.skipIf(skip)("advisory skill candidates", () => {
  for (const kind of ["authoring_capability", "failure_pattern"] as const) {
    test(`${kind} is refused and creates no skill`, async () => {
      const row = await seed(kind);
      await expect(
        approveSkillCandidate(
          { tenant_id: tenantId, candidate_id: row.id, actor_id: "anp-actor" },
          testDb.db,
        ),
      ).rejects.toBeInstanceOf(AdvisoryCandidateError);
      const [after] = await testDb.db
        .select({ status: skillCandidates.status })
        .from(skillCandidates)
        .where(eq(skillCandidates.id, row.id));
      expect(after?.status).toBe("proposed");
      const created = await testDb.db.select().from(skills).where(eq(skills.tenant_id, tenantId));
      expect(created).toEqual([]);
    });
  }
});
