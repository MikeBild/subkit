import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { runMigrations } from "../../db/migrate.ts";
import {
  events,
  executions,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { type CreateExecutionParams, createExecution } from "../state.ts";

let ctx: TestDb;
let counter = 0;
const actor = "00000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  ctx = await createTestDb("authority_reservation");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(patch: Partial<typeof workflowExecutionAuthorities.$inferInsert> = {}) {
  const slug = `authority-reservation-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      version: 1,
      dag: { name: slug, steps: [{ id: "result", kind: "transform", expression: "return 1;" }] },
    })
    .returning();
  if (!version) throw new Error("missing version fixture");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  const now = await databaseNow(ctx.db);
  const [authority] = await ctx.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: "a".repeat(64),
      effect_manifest: { schema_version: 1 },
      execution_environment: "dev",
      target_constraints: { targets: [] },
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: new Date(now.getTime() + 60 * 60_000),
      max_runs: 1,
      created_by: actor,
      ...patch,
    })
    .returning();
  if (!authority) throw new Error("missing authority fixture");
  const params: CreateExecutionParams = {
    tenant_id: tenant.id,
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    execution_authority_id: authority.id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    execution_mode: "dev",
    input: { key: "original" },
  };
  return { params, authority, workflow, version };
}

async function reserved(id: string) {
  const [row] = await ctx.db
    .select({ count: workflowExecutionAuthorities.reserved_runs })
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.id, id));
  return row?.count;
}

test("queued execution, reservation and authority-tagged outbox event commit together", async () => {
  const f = await fixture();
  const id = await createExecution(ctx.db, f.params);
  expect(await reserved(f.authority.id)).toBe(1);
  const [execution] = await ctx.db.select().from(executions).where(eq(executions.id, id));
  expect(execution).toMatchObject({ status: "queued", execution_authority_id: f.authority.id });
  const outbox = await ctx.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, f.params.tenant_id), eq(events.type, "execution.queued")));
  expect(outbox).toHaveLength(1);
  expect(outbox[0]?.payload).toMatchObject({
    execution_id: id,
    execution_authority_id: f.authority.id,
  });
});

test("parallel inserts can reserve the final run only once", async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([
    createExecution(ctx.db, f.params),
    createExecution(ctx.db, f.params),
    createExecution(ctx.db, f.params),
  ]);
  expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(2);
  expect(await reserved(f.authority.id)).toBe(1);
  expect(
    await ctx.db.select().from(executions).where(eq(executions.tenant_id, f.params.tenant_id)),
  ).toHaveLength(1);
});

test("an idempotency conflict rolls back its attempted reservation", async () => {
  const f = await fixture({ max_runs: 2 });
  const params = { ...f.params, idempotency_key: "same-reviewed-run" };
  await createExecution(ctx.db, params);
  await expect(createExecution(ctx.db, params)).rejects.toThrow();
  expect(await reserved(f.authority.id)).toBe(1);
  expect(
    await ctx.db.select().from(executions).where(eq(executions.tenant_id, f.params.tenant_id)),
  ).toHaveLength(1);
});

test("an outer transaction can roll the execution and its reservation back", async () => {
  const f = await fixture();
  await expect(
    ctx.db.transaction(async (tx) => {
      await createExecution(tx, f.params);
      throw new Error("fixture admission aborted");
    }),
  ).rejects.toThrow("fixture admission aborted");
  expect(await reserved(f.authority.id)).toBe(0);
  expect(
    await ctx.db.select().from(executions).where(eq(executions.tenant_id, f.params.tenant_id)),
  ).toHaveLength(0);
  expect(
    await ctx.db.select().from(events).where(eq(events.tenant_id, f.params.tenant_id)),
  ).toHaveLength(0);
});

test("an outbox failure does not spend a run", async () => {
  const f = await fixture();
  await ctx.db.execute(
    sql.raw(`CREATE FUNCTION subkit.reject_authorized_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.type = 'execution.queued' THEN RAISE EXCEPTION 'fixture outbox unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_authorized_outbox BEFORE INSERT ON subkit.events FOR EACH ROW EXECUTE FUNCTION subkit.reject_authorized_outbox()`),
  );
  try {
    await expect(createExecution(ctx.db, f.params)).rejects.toThrow();
    expect(await reserved(f.authority.id)).toBe(0);
    expect(
      await ctx.db.select().from(executions).where(eq(executions.tenant_id, f.params.tenant_id)),
    ).toHaveLength(0);
  } finally {
    await ctx.db.execute(
      sql.raw(
        "DROP TRIGGER reject_authorized_outbox ON subkit.events; DROP FUNCTION subkit.reject_authorized_outbox()",
      ),
    );
  }
});

test("expired, future, revoked and exhausted authorities cannot admit a run", async () => {
  const now = Date.now(); // allow-wall-clock: exercise the database's live reservation window
  for (const patch of [
    { valid_from: new Date(now - 120_000), valid_until: new Date(now - 60_000) },
    { valid_from: new Date(now + 60_000), valid_until: new Date(now + 120_000) },
    { revoked_at: new Date(now), revoked_by: actor },
    { reserved_runs: 1 },
  ]) {
    const f = await fixture(patch);
    await expect(createExecution(ctx.db, f.params)).rejects.toThrow();
    expect(await reserved(f.authority.id)).toBe(patch.reserved_runs ?? 0);
  }
});

test("cross-tenant, cross-environment and inactive-version admission fail closed", async () => {
  const f = await fixture();
  const other = await fixture();
  for (const patch of [
    { tenant_id: other.params.tenant_id },
    { execution_mode: "prod" as const },
    { workflow_version_id: other.version.id },
  ])
    await expect(createExecution(ctx.db, { ...f.params, ...patch })).rejects.toThrow();
  await ctx.db.update(workflows).set({ lifecycle: "draft" }).where(eq(workflows.id, f.workflow.id));
  await expect(createExecution(ctx.db, f.params)).rejects.toThrow();
  expect(await reserved(f.authority.id)).toBe(0);
  expect(await reserved(other.authority.id)).toBe(0);
});

test("an admitted execution cannot change authority or input but can progress normally", async () => {
  const f = await fixture();
  const id = await createExecution(ctx.db, f.params);
  for (const patch of [
    { execution_authority_id: null },
    { input: { key: "replacement" } },
    { execution_mode: "prod" as const },
  ])
    await expect(
      ctx.db.update(executions).set(patch).where(eq(executions.id, id)).execute(),
    ).rejects.toThrow();
  await ctx.db.update(executions).set({ status: "running" }).where(eq(executions.id, id));
  const unbound = await createExecution(ctx.db, { ...f.params, execution_authority_id: null });
  await expect(
    ctx.db
      .update(executions)
      .set({ execution_authority_id: f.authority.id })
      .where(eq(executions.id, unbound))
      .execute(),
  ).rejects.toThrow();
  expect(await reserved(f.authority.id)).toBe(1);
});

test("upgrading preserves executions created before authorities without assigning or consuming an authority", async () => {
  const upgraded = await createTestDb("authority_reservation_upgrade", { upToIdx: 54 });
  try {
    const owner = await upgraded.pool.query<{ id: string }>(
      "INSERT INTO subkit.tenants (slug,display_name) VALUES ('upgraded-run','Upgraded run') RETURNING id",
    );
    const tenant = owner.rows[0]?.id;
    if (!tenant) throw new Error("missing upgraded tenant fixture");
    const inserted = await upgraded.pool.query<{ id: string }>(
      "INSERT INTO subkit.executions (tenant_id,source_kind,status,request_source,execution_mode,input) VALUES ($1,'draft','queued','api','dev','{\"original\":true}') RETURNING id",
      [tenant],
    );
    await runMigrations(upgraded.db);
    const [row] = await upgraded.db
      .select()
      .from(executions)
      .where(eq(executions.id, inserted.rows[0]!.id));
    expect(row).toMatchObject({
      execution_authority_id: null,
      status: "queued",
      input: { original: true },
    });
    expect(await upgraded.db.select().from(workflowExecutionAuthorities)).toHaveLength(0);
  } finally {
    await upgraded.cleanup();
  }
});
