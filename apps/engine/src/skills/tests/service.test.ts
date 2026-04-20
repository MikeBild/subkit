import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  activateSkill,
  archiveSkill,
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  retrieveApplicableSkills,
  updateSkill,
} from "../service.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("skills_svc");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: legacy; review before changing
    .returning();
  return t!.id;
}

describe("skills/service", () => {
  test("CRUD + lifecycle + retrieval order", async () => {
    const tenant_id = await seedTenant();

    const global = await createSkill(
      {
        tenant_id,
        input: {
          scope: "global",
          title: "prefer-cursor",
          body: "Always prefer cursor pagination for list endpoints.",
          examples: ["GET /users?cursor=..."],
          best_practices: ["page_size <= 100"],
          pitfalls: ["never use offset with mutable lists"],
          doc_refs: ["https://docs.example/pagination"],
        },
      },
      ctx.db,
    );
    expect(global.scope).toBe("global");
    expect(global.status).toBe("active");
    expect(global.version).toBe(1);
    expect(global.examples).toEqual(["GET /users?cursor=..."]);

    // scope validation
    await expect(
      createSkill({ tenant_id, input: { scope: "connector", title: "x", body: "x" } }, ctx.db),
    ).rejects.toThrow(/connector_id/);

    // Create a connector-scoped and workflow-scoped pair, plus an archived
    // connector skill that should be filtered out by retrieval.
    const fakeConnectorId = crypto.randomUUID(); // allow-random: legacy; review before changing
    const fakeWorkflowId = crypto.randomUUID();
    const connectorSkill = await createSkill(
      {
        tenant_id,
        input: {
          scope: "connector",
          connector_id: fakeConnectorId,
          title: "stripe-idempotency",
          body: "Always attach Idempotency-Key on Stripe POSTs.",
        },
      },
      ctx.db,
    );
    const archivedConnector = await createSkill(
      {
        tenant_id,
        input: {
          scope: "connector",
          connector_id: fakeConnectorId,
          title: "old-rule",
          body: "do not use",
        },
      },
      ctx.db,
    );
    await archiveSkill(tenant_id, archivedConnector.id, null, ctx.db);
    const workflowSkill = await createSkill(
      {
        tenant_id,
        input: {
          scope: "workflow",
          workflow_id: fakeWorkflowId,
          title: "midnight-no-page",
          body: "Never trigger page-roll mutations at midnight UTC.",
        },
      },
      ctx.db,
    );

    // get + list
    const fetched = await getSkill(tenant_id, global.id, ctx.db);
    expect(fetched?.id).toBe(global.id);
    const all = await listSkills({ tenant_id }, ctx.db);
    expect(all.length).toBeGreaterThanOrEqual(4);

    // update bumps version, preserves fields
    const patched = await updateSkill(
      tenant_id,
      global.id,
      { body: "Always prefer cursor pagination. Page size 100." },
      null,
      ctx.db,
    );
    expect(patched?.version).toBe(2);
    expect(patched?.examples).toEqual(["GET /users?cursor=..."]);

    // activate is idempotent
    const reactivated = await activateSkill(tenant_id, patched!.id, null, ctx.db);
    expect(reactivated?.status).toBe("active");

    // retrieval: global → connector → workflow, archived dropped
    const applicable = await retrieveApplicableSkills(
      { tenant_id, connector_ids: [fakeConnectorId], workflow_ids: [fakeWorkflowId] },
      ctx.db,
    );
    const ids = applicable.map((s) => s.id);
    expect(ids).toContain(patched!.id);
    expect(ids).toContain(connectorSkill.id);
    expect(ids).toContain(workflowSkill.id);
    expect(ids).not.toContain(archivedConnector.id);
    // ordering: global first, then connector, then workflow
    const globalIdx = ids.indexOf(patched!.id);
    const connectorIdx = ids.indexOf(connectorSkill.id);
    const workflowIdx = ids.indexOf(workflowSkill.id);
    expect(globalIdx).toBeLessThan(connectorIdx);
    expect(connectorIdx).toBeLessThan(workflowIdx);

    // delete
    const ok = await deleteSkill(tenant_id, workflowSkill.id, null, ctx.db);
    expect(ok).toBe(true);
    const gone = await getSkill(tenant_id, workflowSkill.id, ctx.db);
    expect(gone).toBeNull();
  });
});
