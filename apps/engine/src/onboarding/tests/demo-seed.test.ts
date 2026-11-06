import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { DEMO_WORKFLOWS, seedOnboardingDemo } from "../demo-seed.ts";

let tdb: TestDb;
let tenantId: string;
const seedAuthor = "10000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  tdb = await createTestDb("onboarding-demo-seed");
  tenantId = (await seedTenant(tdb.db, { slug: "demo-seed-test", display_name: "Demo Seed Test" }))
    .id;
});

afterAll(async () => {
  await tdb.cleanup();
});

describe("onboarding demo seed", () => {
  test("every shipped DAG is valid against the workflow schema", () => {
    for (const spec of DEMO_WORKFLOWS) {
      expect(() => WorkflowDefSchema.parse(spec.dag)).not.toThrow();
    }
  });

  test("creates every demo workflow on first run, skips all on second run", async () => {
    const first = await seedOnboardingDemo(
      { tenant_id: tenantId, actor_id: seedAuthor, actor_type: "user" },
      tdb.db,
    );
    expect(first.created.sort()).toEqual([...DEMO_WORKFLOWS].map((s) => s.slug).sort());
    expect(first.skipped).toEqual([]);

    const second = await seedOnboardingDemo({ tenant_id: tenantId }, tdb.db);
    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual([...DEMO_WORKFLOWS].map((s) => s.slug).sort());
  });

  test("each seeded workflow has a version 1 row with the correct DAG and a current_version_id pointer", async () => {
    const rows = await tdb.db.select().from(workflows).where(eq(workflows.tenant_id, tenantId));
    expect(rows.length).toBeGreaterThanOrEqual(DEMO_WORKFLOWS.length);
    for (const spec of DEMO_WORKFLOWS) {
      const wf = rows.find((r) => r.slug === spec.slug);
      expect(wf).toBeDefined();
      expect(wf!.lifecycle).toBe("active");
      expect(wf!.current_version_id).not.toBeNull();

      const versions = await tdb.db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflow_id, wf!.id));
      expect(versions).toHaveLength(1);
      expect(versions[0]!.version).toBe(1);
      expect(versions[0]!.author_user_id).toBe(seedAuthor);
      expect(versions[0]!.author_system_account_id).toBeNull();
    }
  });

  test("an actor ID without a type stays unknown and does not become a version author", async () => {
    const tenant = await seedTenant(tdb.db, {
      slug: "demo-seed-unknown-actor",
      display_name: "Unknown Actor Seed",
    });

    const actorId = "20000000-0000-4000-8000-000000000002";
    const result = await seedOnboardingDemo({ tenant_id: tenant.id, actor_id: actorId }, tdb.db);
    expect(result.created).toHaveLength(DEMO_WORKFLOWS.length);

    const versions = await tdb.db
      .select({
        author_user_id: workflowVersions.author_user_id,
        author_system_account_id: workflowVersions.author_system_account_id,
      })
      .from(workflowVersions)
      .where(eq(workflowVersions.tenant_id, tenant.id));
    expect(versions).toHaveLength(DEMO_WORKFLOWS.length);
    expect(
      versions.every(
        (version) => version.author_user_id === null && version.author_system_account_id === null,
      ),
    ).toBe(true);

    const audits = await tdb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, tenant.id));
    expect(audits).toHaveLength(DEMO_WORKFLOWS.length);
    expect(audits.every((audit) => audit.actor_type === "unknown" && audit.actor_id === null)).toBe(
      true,
    );
  });
});
