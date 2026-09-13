// Shared test scaffolding for inbound webhook tests.
//
// Each test file uses `createInboundCtx()` to get:
//   * a disposable database
//   * seeded tenant + workflow
//   * a ready-to-use `createInbound()` helper that returns the row
//     plus the plaintext secret used for signing requests.

import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import type { Db } from "../../../db/client.ts";
import { tenants, workflows, workflowVersions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../../../queue/boss.ts";
import { grantScheduleAuthorityFixture } from "../../../scheduler/tests/authority-fixture.ts";
import { createInbound, type InboundRow } from "../service.ts";

export interface InboundTestCtx {
  testDb: TestDb;
  db: Db;
  boss: PgBoss;
  tenantId: string;
  workflowId: string;
  grantAuthority: (
    environment?: "dev" | "prod",
    maxRuns?: number,
  ) => ReturnType<typeof grantScheduleAuthorityFixture>;
  cleanup: () => Promise<void>;
  createBinding: (params: {
    slug: string;
    verifier: "standard" | "github" | "stripe";
    secret: string;
  }) => Promise<InboundRow>;
}

export async function createInboundCtx(label: string): Promise<InboundTestCtx> {
  const testDb = await createTestDb(`wh-inbound-${label}`);
  const boss = await createBoss({ connectionString: testDb.url });

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-${label}`, display_name: `Test ${label}` })
    .returning();
  if (!tenant) throw new Error("tenant seed failed");

  const [wf] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenant.id,
      slug: `wf-${label}`,
      name: `wf-${label}`,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("workflow seed failed");

  const [version] = await testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant.id,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: `wf-${label}`,
        version: 1,
        steps: [
          { id: "noop", kind: "transform", language: "javascript", expression: "return input;" },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("workflow version seed failed");

  await testDb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));

  return {
    testDb,
    db: testDb.db,
    boss,
    tenantId: tenant.id,
    workflowId: wf.id,
    grantAuthority: (environment = "prod", maxRuns = 100) =>
      grantScheduleAuthorityFixture(testDb.db, tenant.id, wf.id, environment, maxRuns),
    cleanup: async () => {
      await disposeBoss(boss);
      await testDb.cleanup();
    },
    createBinding: async (params) => {
      return await createInbound(
        {
          tenant_id: tenant.id,
          actor_id: null,
          slug: params.slug,
          workflow_id: wf.id,
          verifier: params.verifier,
          secret: params.secret,
        },
        testDb.db,
      );
    },
  };
}
