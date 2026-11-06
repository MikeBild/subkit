import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  connectors,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { grantWorkflowAuthority, previewWorkflowAuthority } from "../execution-authorities.ts";
import { listWorkflows } from "../service.ts";
import { executionAuthoritiesFixtures } from "./execution-authorities-fixtures.ts";

let ctx: TestDb;

const { fixture } = executionAuthoritiesFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("authority_grant");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("operating status verifies approval effect binding and does not infer readiness from a stored grant", async () => {
  const f = await fixture();
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: f.workflow.tenant_id,
      slug: "operating-status-target",
      display_name: "Operating status target",
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: "https://approved.example.test",
    })
    .returning();
  if (!connector) throw new Error("missing operating status connector fixture");
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: f.workflow.name,
        steps: [
          {
            id: "send",
            kind: "request",
            connector_id: connector.id,
            method: "POST",
            path: "/messages",
            body: { recipient: "reviewed@example.test" },
          },
        ],
      },
    })
    .where(
      and(
        eq(workflowVersions.tenant_id, f.workflow.tenant_id),
        eq(workflowVersions.id, f.version.id),
      ),
    );
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  f.input.expected_manifest_digest = preview.digest;
  const authority = await grantWorkflowAuthority(
    f.workflow.id,
    { ...f.input, valid_until: null, max_runs: null },
    f.context,
  );
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id, draft_version_id: null })
    .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
  await ctx.db.insert(workflowsSchedules).values({
    tenant_id: f.workflow.tenant_id,
    workflow_id: f.workflow.id,
    cron: "0 9 * * *",
    timezone: "UTC",
    execution_mode: "dev",
  });
  const opts = {
    include_operating_status: true,
    operating_access: { schedules: true, hooks: true, connectors: true },
  };
  const ready = await listWorkflows(f.workflow.tenant_id, opts, ctx.db);
  expect(ready.rows[0]?.operating_status).toBe("active");
  const hidden = await listWorkflows(
    f.workflow.tenant_id,
    { include_operating_status: true },
    ctx.db,
  );
  expect(hidden.rows[0]?.operating_status).toBe("unknown");
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://changed.example.test" })
    .where(and(eq(connectors.tenant_id, f.workflow.tenant_id), eq(connectors.id, connector.id)));
  const [storedAuthority] = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, f.workflow.tenant_id),
        eq(workflowExecutionAuthorities.id, authority.id),
      ),
    );
  expect(storedAuthority?.effect_manifest_digest).toBe(preview.digest);
  expect(storedAuthority?.revoked_at).toBeNull();
  const invalidated = await listWorkflows(f.workflow.tenant_id, opts, ctx.db);
  expect(invalidated.rows[0]?.operating_status).toBe("stopped");
  expect(
    (await listWorkflows(f.workflow.tenant_id, { ...opts, operating_status: "active" }, ctx.db))
      .total,
  ).toBe(0);
});

test("operating status of a workflow without triggers or approvals follows its connectors", async () => {
  const statusFor = async (environment: "dev" | "prod") => {
    const f = await fixture();
    const [connector] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: f.workflow.tenant_id,
        slug: `untriggered-${environment}`,
        display_name: `Untriggered ${environment}`,
        driver: "http",
        auth_type: "none",
        environment,
        base_url: "https://approved.example.test",
      })
      .returning();
    if (!connector) throw new Error("missing connector fixture");
    await ctx.db
      .update(workflowVersions)
      .set({
        dag: {
          name: f.workflow.name,
          steps: [
            {
              id: "send",
              kind: "request",
              connector_id: connector.id,
              method: "POST",
              path: "/messages",
              body: { recipient: "reviewed@example.test" },
            },
          ],
        },
      })
      .where(
        and(
          eq(workflowVersions.tenant_id, f.workflow.tenant_id),
          eq(workflowVersions.id, f.version.id),
        ),
      );
    await ctx.db
      .update(workflows)
      .set({ lifecycle: "active", current_version_id: f.version.id, draft_version_id: null })
      .where(and(eq(workflows.tenant_id, f.workflow.tenant_id), eq(workflows.id, f.workflow.id)));
    const listed = await listWorkflows(
      f.workflow.tenant_id,
      {
        include_operating_status: true,
        operating_access: { schedules: true, hooks: true, connectors: true },
      },
      ctx.db,
    );
    return listed.rows.find((row) => row.id === f.workflow.id)?.operating_status;
  };
  const inDev = await statusFor("dev");
  const inProd = await statusFor("prod");
  expect(inProd).toBe(inDev);
  expect(inProd).not.toBe("stopped");
});

test("batched operating evidence keeps workflow versions, environments and effect boundaries separate", async () => {
  const f = await fixture();
  const tenantId = f.workflow.tenant_id;
  async function approved(name: string, environment: "dev" | "prod", versionNumber: number) {
    const [connector] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenantId,
        slug: name,
        display_name: name,
        driver: "http",
        auth_type: "none",
        environment,
        base_url: `https://${name}.example.test`,
      })
      .returning();
    const [workflow] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: name,
        name,
        lifecycle: "active",
      })
      .returning();
    if (!connector || !workflow) throw new Error("missing batch fixture");
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        version: versionNumber,
        dag: {
          name,
          steps: [
            {
              id: "send",
              kind: "request",
              connector_id: connector.id,
              method: "POST",
              path: "/messages",
              body: { recipient: "reviewed@example.test" },
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("missing batch version");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflow.id)));
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: tenantId,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        execution_environment: environment,
      },
      ctx.db,
    );
    await grantWorkflowAuthority(
      workflow.id,
      {
        ...f.input,
        workflow_version_id: version.id,
        expected_manifest_digest: preview.digest,
        execution_environment: environment,
        valid_until: null,
        max_runs: null,
      },
      f.context,
    );
    const [schedule] = await ctx.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: tenantId,
        workflow_id: workflow.id,
        cron: "0 9 * * *",
        timezone: "UTC",
        execution_mode: environment,
      })
      .returning();
    if (!schedule) throw new Error("missing batch schedule");
    return { workflow, connector, version, schedule };
  }
  const first = await approved("batch-a", "dev", 1);
  const second = await approved("batch-b", "prod", 2);
  const third = await approved("batch-c", "dev", 3);
  const opts = {
    include_operating_status: true,
    name_contains: "batch-",
    sort: "name" as const,
    order: "asc" as const,
    operating_access: { schedules: true, hooks: true, connectors: true },
  };
  const initial = await listWorkflows(tenantId, opts, ctx.db);
  expect(initial.rows.map((row) => [row.id, row.operating_status])).toEqual([
    [first.workflow.id, "active"],
    [second.workflow.id, "active"],
    [third.workflow.id, "active"],
  ]);
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://unreviewed.example.test" })
    .where(and(eq(connectors.tenant_id, tenantId), eq(connectors.id, first.connector.id)));
  const changed = await listWorkflows(tenantId, opts, ctx.db);
  expect(changed.rows.map((row) => [row.id, row.operating_status])).toEqual([
    [first.workflow.id, "stopped"],
    [second.workflow.id, "active"],
    [third.workflow.id, "active"],
  ]);
  const page = await listWorkflows(
    tenantId,
    {
      ...opts,
      operating_status: "active",
      limit: 1,
      offset: 1,
    },
    ctx.db,
  );
  expect(page.total).toBe(2);
  expect(page.rows.map((row) => row.id)).toEqual([third.workflow.id]);
  const exhausted = await listWorkflows(
    tenantId,
    {
      ...opts,
      operating_status: "active",
      limit: 1,
      offset: 2,
    },
    ctx.db,
  );
  expect(exhausted.total).toBe(2);
  expect(exhausted.rows).toEqual([]);
  const hidden = await listWorkflows(
    tenantId,
    { ...opts, operating_access: { schedules: false, hooks: false, connectors: false } },
    ctx.db,
  );
  expect(hidden.rows.map((row) => [row.id, row.operating_status])).toEqual([
    [first.workflow.id, "unknown"],
    [second.workflow.id, "unknown"],
    [third.workflow.id, "unknown"],
  ]);
});
