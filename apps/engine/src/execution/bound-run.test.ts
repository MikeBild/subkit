import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  executionSteps,
  executions,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { bindExistingRun } from "./bound-run.ts";
import { runExecution } from "./engine.ts";
import { createExecution } from "./state.ts";

let fixture: TestDb;
let tenantId = "";
let otherTenantId = "";
let workflowId = "";
let versionId = "";
let laterVersionId = "";

beforeAll(async () => {
  fixture = await createTestDb("bound-run");
  const rows = await fixture.db
    .insert(tenants)
    .values([
      { slug: "bound-run", display_name: "Bound Run" },
      { slug: "bound-run-other", display_name: "Other" },
    ])
    .returning();
  tenantId = rows[0]!.id;
  otherTenantId = rows[1]!.id;
  const [workflow] = await fixture.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: "bound",
      name: "Bound",
      lifecycle: "active",
    })
    .returning();
  workflowId = workflow!.id;
  const versions = await fixture.db
    .insert(workflowVersions)
    .values(
      [1, 2].map((version) => ({
        tenant_id: tenantId,
        workflow_id: workflowId,
        version,
        dag: {
          name: "Bound",
          steps: [
            { id: `version-${version}`, kind: "transform", expression: "return input.input;" },
          ],
        },
      })),
    )
    .returning();
  versionId = versions[0]!.id;
  laterVersionId = versions[1]!.id;
  await fixture.db
    .update(workflows)
    .set({ current_version_id: laterVersionId })
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflowId)));
});

afterAll(async () => {
  if (fixture) await fixture.cleanup();
});

function queued() {
  return createExecution(fixture.db, {
    tenant_id: tenantId,
    workflow_id: workflowId,
    workflow_version_id: versionId,
    source_kind: "saved",
    source_ref: null,
    execution_mode: "prod",
    request_source: "scheduler",
    input: { allowed: true },
  });
}

test("an existing run executes its recorded version, not the newly active version", async () => {
  const id = await queued();
  const result = await runExecution({
    db: fixture.db,
    tenant_id: tenantId,
    source: { kind: "saved", workflow_id: workflowId },
    input: { allowed: true },
    options: { existing_execution_id: id, self_healing: { enabled: false } },
  });
  expect(result).toMatchObject({ status: "succeeded", error: null });
  const steps = await fixture.db
    .select()
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, tenantId), eq(executionSteps.execution_id, id)));
  expect(steps.map((step) => step.step_key)).toEqual(["version-1"]);
  const [row] = await fixture.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, id)));
  expect(row?.workflow_version_id).toBe(versionId);
  expect(row?.execution_mode).toBe("prod");
});

test("queue data cannot substitute a version, environment, input, source or tenant", async () => {
  const id = await queued();
  const saved = { kind: "saved" as const, workflow_id: workflowId };
  for (const attempt of [
    {
      tenant: tenantId,
      source: { ...saved, version_id: laterVersionId },
      input: { allowed: true },
      options: {},
    },
    {
      tenant: tenantId,
      source: { ...saved, workflow_id: laterVersionId },
      input: { allowed: true },
      options: {},
    },
    {
      tenant: tenantId,
      source: saved,
      input: { allowed: true },
      options: { execution_mode: "dev" as const },
    },
    { tenant: tenantId, source: saved, input: { allowed: false }, options: {} },
    { tenant: otherTenantId, source: saved, input: { allowed: true }, options: {} },
    {
      tenant: tenantId,
      source: { kind: "draft" as const, definition: {} },
      input: { allowed: true },
      options: {},
    },
  ]) {
    await expect(
      bindExistingRun(fixture.db, attempt.tenant, attempt.source, attempt.input, {
        ...attempt.options,
        existing_execution_id: id,
      }),
    ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  }
  const bound = await bindExistingRun(
    fixture.db,
    tenantId,
    saved,
    { allowed: true },
    {
      existing_execution_id: id,
      request_source: "api",
    },
  );
  expect(bound.options.execution_mode).toBe("prod");
  expect(bound.options.request_source).toBe("scheduler");
  expect(bound.source).toEqual({ ...saved, version_id: versionId });
  await expect(
    bindExistingRun(
      fixture.db,
      tenantId,
      saved,
      { allowed: true },
      {
        existing_execution_id: versionId,
      },
    ),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
});
