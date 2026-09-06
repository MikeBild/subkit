import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  connectors,
  executions,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../authority-admission.ts";
import { bindExistingRun } from "../bound-run.ts";

let ctx: TestDb;
let counter = 0;
const actor = "00000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  ctx = await createTestDb("authority_admission");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(max_runs = 2, input_schema?: object, valid_until?: Date) {
  const slug = `authority-admission-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: "https://example.test/api",
    })
    .returning();
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow || !connector) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        ...(input_schema ? { input_schema } : {}),
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
  if (!version) throw new Error("missing version fixture");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  const now = await databaseNow(ctx.db);
  // Human grant verification has its own service/HTTP tests. This fixture
  // installs the real server-resolved boundary to test execution admission.
  const [authority] = await ctx.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: { targets: ["https://example.test/api/messages"] },
      execution_environment: "dev",
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: valid_until ?? new Date(now.getTime() + 60 * 60_000),
      max_runs,
      created_by: actor,
    })
    .returning();
  if (!authority) throw new Error("missing authority fixture");
  return {
    authority,
    connector,
    version,
    workflow,
    params: {
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      execution_environment: "dev" as const,
      request_source: "api" as const,
      input: { message: "approved input" },
    },
  };
}

async function reservations(id: string) {
  const [row] = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.id, id));
  return row?.reserved_runs;
}

test("successive runs automatically use the matching authority without another grant", async () => {
  const f = await fixture();
  const first = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  const second = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  expect(first.execution_id).not.toBe(second.execution_id);
  expect(first.execution_authority_id).toBe(f.authority.id);
  expect(second.execution_authority_id).toBe(f.authority.id);
  expect(await reservations(f.authority.id)).toBe(2);
  // Exhaustion prevents a NEW reservation, not either already-reserved run.
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, first.execution_id);
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, second.execution_id);
  await expect(admitAuthorizedWorkflowExecution(f.params, ctx.db)).rejects.toMatchObject({
    code: "execution_authority_unavailable",
  });
});

test("concurrent retries preserve one execution and one reservation", async () => {
  const f = await fixture(1);
  const params = { ...f.params, idempotency_key: "one-run" };
  const results = await Promise.all([
    admitAuthorizedWorkflowExecution(params, ctx.db),
    admitAuthorizedWorkflowExecution(params, ctx.db),
  ]);
  expect(results[0]?.execution_id).toBe(results[1]?.execution_id);
  expect(results.map((row) => row.replayed).sort()).toEqual([false, true]);
  expect(await reservations(f.authority.id)).toBe(1);
  await expect(
    admitAuthorizedWorkflowExecution({ ...params, input: { message: "different" } }, ctx.db),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  expect(await reservations(f.authority.id)).toBe(1);
});

test("input validation runs before a reservation is consumed", async () => {
  const f = await fixture(1, {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  });
  await expect(
    admitAuthorizedWorkflowExecution({ ...f.params, input: {} }, ctx.db),
  ).rejects.toMatchObject({ code: "input_schema_violation" });
  expect(await reservations(f.authority.id)).toBe(0);
  expect(
    await ctx.db.select().from(executions).where(eq(executions.tenant_id, f.params.tenant_id)),
  ).toHaveLength(0);
});

test("a changed target cannot spend the explicitly supplied old authority", async () => {
  const f = await fixture();
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://other.example.test/api" })
    .where(eq(connectors.id, f.connector.id));
  await expect(
    admitAuthorizedWorkflowExecution(
      { ...f.params, execution_authority_id: f.authority.id },
      ctx.db,
    ),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  expect(await reservations(f.authority.id)).toBe(0);
});

test("revocation between queueing and dispatch blocks an existing reservation", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await ctx.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: await databaseNow(ctx.db), revoked_by: actor })
    .where(eq(workflowExecutionAuthorities.id, f.authority.id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_unavailable" });
  expect(await reservations(f.authority.id)).toBe(1);
});

test("target drift after queueing is checked again before dispatch", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://other.example.test/api" })
    .where(eq(connectors.id, f.connector.id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
});

test("worker binding fixes execution options and refuses wider replay overrides", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  const source = { kind: "saved" as const, workflow_id: f.workflow.id };
  const options = { existing_execution_id: run.execution_id };
  const bound = await bindExistingRun(ctx.db, f.params.tenant_id, source, f.params.input, options);
  expect(bound.source).toMatchObject({ version_id: f.version.id });
  expect(bound.options).toMatchObject({
    execution_mode: "dev",
    self_healing: { enabled: false },
    hold_writes: false,
  });
  for (const patch of [
    { self_healing: { enabled: true } },
    { step_output_fixtures: {} },
    { hold_writes: true },
  ]) {
    await expect(
      bindExistingRun(ctx.db, f.params.tenant_id, source, f.params.input, { ...options, ...patch }),
    ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  }
});

test("switching the active version blocks a queued old-version run", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.params.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: f.version.dag,
    })
    .returning();
  if (!next) throw new Error("missing replacement version");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: next.id })
    .where(eq(workflows.id, f.workflow.id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_unavailable" });
});

test("expiry after admission still blocks dispatch", async () => {
  const expires = new Date(Date.now() + 3_000); // allow-wall-clock: real database expiry, not a JS fake clock
  const f = await fixture(1, undefined, expires);
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id);
  await Bun.sleep(Math.max(0, expires.getTime() - Date.now()) + 10); // allow-wall-clock: cross the actual PostgreSQL deadline
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_unavailable" });
});

test("tenant mismatch and cancellation cannot dispatch the reserved run", async () => {
  const f = await fixture();
  const other = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, other.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  await ctx.db
    .update(executions)
    .set({ abort_requested_at: await databaseNow(ctx.db) })
    .where(eq(executions.id, run.execution_id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
});
