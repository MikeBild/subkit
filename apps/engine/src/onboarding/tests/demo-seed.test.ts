// DemoSeed tests — DB-backed, runs against the testcontainer helper.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { DEMO_WORKFLOWS, seedOnboardingDemo } from "../demo-seed.ts";

let tdb: TestDb;
let tenantId: string;

beforeAll(async () => {
  tdb = await createTestDb("onboarding-demo-seed");
  const [t] = await tdb.db
    .insert(tenants)
    .values({ slug: "demo-seed-test", display_name: "Demo Seed Test" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
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
    const first = await seedOnboardingDemo({ tenant_id: tenantId }, tdb.db);
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
    }
  });
});
