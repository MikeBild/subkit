import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction } from "../../audit/types.ts";
import { CatalogVocabularyBusyError, lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import {
  auditLog,
  executionSteps,
  executions,
  workflowExecutionAuthorities,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { logger } from "../../logging/index.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/queues.ts";
import { SchedulerReconciler } from "../../scheduler/reconciler.ts";
import { retryCatalogConflict } from "../../test-helpers/catalog-retry.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { authorityLive } from "../../workflows/authority-live.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../authority-admission.ts";
import type { CallerContext } from "../caller-context.ts";
import { createExecution } from "../state.ts";
import { actor, authorityAdmissionFixtures } from "./authority-admission-fixtures.ts";

let ctx: TestDb;

const { fixture, reservations } = authorityAdmissionFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("authority_admission");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("successive runs automatically use the matching authority without another grant", async () => {
  const f = await fixture();
  const caller = {
    tenantId: f.params.tenant_id,
    principalId: actor,
    principalKind: "user" as const,
    provider: "api_key",
    productId: null,
  };
  const first = await admitAuthorizedWorkflowExecution(f.params, ctx.db, caller);
  const second = await admitAuthorizedWorkflowExecution(f.params, ctx.db, caller);
  expect(first.execution_id).not.toBe(second.execution_id);
  expect(first.execution_authority_id).toBe(f.authority.id);
  expect(second.execution_authority_id).toBe(f.authority.id);
  expect(await reservations(f.authority.id)).toBe(2);
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, first.execution_id);
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, second.execution_id);
  const queuedAudits = await ctx.db
    .select({
      resource_id: auditLog.resource_id,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.params.tenant_id),
        eq(auditLog.action, AuditAction.EXECUTION_QUEUED),
      ),
    );
  expect(queuedAudits).toHaveLength(2);
  expect(queuedAudits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        resource_id: first.execution_id,
        actor_type: "user",
        actor_id: actor,
        metadata: expect.objectContaining({
          request_source: "api",
          source_kind: "saved",
          workflow_id: f.workflow.id,
          workflow_version_id: f.version.id,
          execution_authority_id: f.authority.id,
        }),
      }),
      expect.objectContaining({
        resource_id: second.execution_id,
        actor_type: "user",
        actor_id: actor,
        metadata: expect.objectContaining({
          request_source: "api",
          source_kind: "saved",
          workflow_id: f.workflow.id,
          workflow_version_id: f.version.id,
          execution_authority_id: f.authority.id,
        }),
      }),
    ]),
  );
  for (const entry of queuedAudits) {
    expect(entry.metadata).not.toHaveProperty("input");
    expect(entry.metadata).not.toHaveProperty("source_ref");
    expect(entry.metadata).not.toHaveProperty("caller_context");
  }
  await expect(admitAuthorizedWorkflowExecution(f.params, ctx.db)).rejects.toMatchObject({
    code: "execution_authority_exhausted",
  });
});

test("queue admission rejects caller context from another tenant before persisting it", async () => {
  const f = await fixture();
  const caller = {
    tenantId: "00000000-0000-4000-8000-000000000099",
    principalId: actor,
    principalKind: "user" as const,
    provider: "api_key",
    productId: null,
  };

  await expect(
    createExecution(ctx.db, {
      tenant_id: f.params.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
      caller_context: caller,
    }),
  ).rejects.toMatchObject({ code: "caller_tenant_mismatch" });

  await expect(
    createExecution(ctx.db, {
      tenant_id: f.params.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
      caller_context: false as unknown as CallerContext,
    }),
  ).rejects.toThrow();

  const queued = await ctx.db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.tenant_id, f.params.tenant_id));
  const audit = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.params.tenant_id),
        eq(auditLog.action, AuditAction.EXECUTION_QUEUED),
      ),
    );
  expect(queued).toHaveLength(0);
  expect(audit).toHaveLength(0);
});

test("an approval without run limit or end date admits every run and still counts them", async () => {
  const f = await fixture(null, undefined, null);
  const runs = [];
  for (let i = 0; i < 12; i++) runs.push(await admitAuthorizedWorkflowExecution(f.params, ctx.db));
  expect(new Set(runs.map((run) => run.execution_id)).size).toBe(12);
  expect(runs.every((run) => run.execution_authority_id === f.authority.id)).toBe(true);
  expect(await reservations(f.authority.id)).toBe(12);
  for (const run of runs)
    await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id);
  const [later] = await ctx.db
    .select({ live: sql<boolean>`${authorityLive(sql`clock_timestamp() + interval '50 years'`)}` })
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.id, f.authority.id));
  expect(later?.live).toBe(true);
});

test("revoking an approval that stands until revoked ends it", async () => {
  const f = await fixture(null, undefined, null);
  const queued = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await ctx.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: sql`clock_timestamp()`, revoked_by: actor })
    .where(eq(workflowExecutionAuthorities.id, f.authority.id));
  await expect(admitAuthorizedWorkflowExecution(f.params, ctx.db)).rejects.toMatchObject({
    code: "execution_authority_revoked",
  });
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, queued.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_revoked" });
});

test("cron queue retries reuse one authorized reservation and stop at its run limit", async () => {
  const f = await fixture(1);
  const now = await databaseNow(ctx.db);
  await ctx.db.insert(workflowsSchedules).values({
    tenant_id: f.params.tenant_id,
    workflow_id: f.workflow.id,
    cron: "* * * * *",
    timezone: "UTC",
    execution_mode: "dev",
    paused: false,
    created_at: new Date(now.getTime() - 120_000),
    input: f.params.input,
  });
  const sends: { execution_id: string; job_id: string }[] = [];
  const boss = {
    async send(queue: string, job: { execution_id: string }, options: { id: string }) {
      if (queue !== EXECUTION_RUN_QUEUE) return null;
      sends.push({ execution_id: job.execution_id, job_id: options.id });
      if (sends.length === 1) throw new Error("fixture queue unavailable");
      return options.id;
    },
  } as unknown as PgBoss;
  const scheduler = new SchedulerReconciler({ boss, db: ctx.db, intervalMs: 60_000 });
  await scheduler.reconcileWorkflowSchedules(now);
  expect(sends).toHaveLength(1);
  expect(await reservations(f.authority.id)).toBe(1);
  await scheduler.reconcileWorkflowSchedules(new Date(now.getTime() + 1_000));
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  expect(sends[0]!.job_id).toBe(sends[0]!.execution_id);
  expect(await reservations(f.authority.id)).toBe(1);
  await scheduler.reconcileWorkflowSchedules(new Date(now.getTime() + 70_000));
  expect(sends).toHaveLength(2);
  expect(await reservations(f.authority.id)).toBe(1);
});

test("a held schedule is filed as a refusal, and its release as an admission", async () => {
  const f = await fixture(1);
  const now = await databaseNow(ctx.db);
  const [schedule] = await ctx.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: f.params.tenant_id,
      workflow_id: f.workflow.id,
      cron: "* * * * *",
      timezone: "UTC",
      execution_mode: "dev",
      paused: false,
      created_at: new Date(now.getTime() - 120_000),
      input: f.params.input,
    })
    .returning();
  if (!schedule) throw new Error("missing schedule fixture");
  const boss = {
    async send(_q: string, _j: unknown, o: { id: string }) {
      return o.id;
    },
  } as unknown as PgBoss;
  const scheduler = new SchedulerReconciler({ boss, db: ctx.db, intervalMs: 60_000 });
  const rows = async () =>
    ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, f.params.tenant_id),
          eq(auditLog.action, "schedule.admission.changed"),
          eq(auditLog.resource_id, schedule.id),
        ),
      )
      .orderBy(auditLog.ts);

  await scheduler.reconcileWorkflowSchedules(now);
  expect(await rows()).toHaveLength(0);
  await scheduler.reconcileWorkflowSchedules(new Date(now.getTime() + 70_000));

  const held = await rows();
  expect(held).toHaveLength(1);
  expect(held[0]?.result).toBe("denied");
  expect(held[0]?.reason).toBe("execution_authority_exhausted");
  expect((held[0]?.metadata as Record<string, unknown> | undefined)?.reason_code).toBe(
    "execution_authority_exhausted",
  );
  expect((held[0]?.metadata as Record<string, unknown> | undefined)?.state).toBe("held");

  const preview = await previewWorkflowAuthority(
    {
      tenant_id: f.params.tenant_id,
      workflow_id: f.workflow.id,
      workflow_version_id: f.version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  await ctx.db.insert(workflowExecutionAuthorities).values({
    tenant_id: f.params.tenant_id,
    workflow_id: f.workflow.id,
    workflow_version_id: f.version.id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: {
      targets: preview.manifest.effects.flatMap((effect) => (effect.target ? [effect.target] : [])),
    },
    execution_environment: "dev",
    valid_from: new Date(now.getTime() - 60_000),
    valid_until: new Date(now.getTime() + 60 * 60_000),
    max_runs: 5,
    created_by: actor,
  });
  await scheduler.reconcileWorkflowSchedules(new Date(now.getTime() + 140_000));

  const released = await rows();
  expect(released).toHaveLength(2);
  expect(released[1]?.result).toBe("success");
  expect(released[1]?.reason).toBeNull();
  expect((released[1]?.metadata as Record<string, unknown> | undefined)?.state).toBe("admitted");
});

test("concurrent retries preserve one execution and one reservation", async () => {
  const f = await fixture(1);
  const params = { ...f.params, idempotency_key: "one-run" };
  const results = await Promise.all([
    retryCatalogConflict(() => admitAuthorizedWorkflowExecution(params, ctx.db)),
    retryCatalogConflict(() => admitAuthorizedWorkflowExecution(params, ctx.db)),
  ]);
  expect(results[0]?.execution_id).toBe(results[1]?.execution_id);
  expect(results.map((row) => row.replayed).sort()).toEqual([false, true]);
  expect(await reservations(f.authority.id)).toBe(1);
  const queuedAudits = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.params.tenant_id),
        eq(auditLog.resource_id, results[0]?.execution_id ?? ""),
        eq(auditLog.action, AuditAction.EXECUTION_QUEUED),
      ),
    );
  expect(queuedAudits).toHaveLength(1);
  await expect(
    admitAuthorizedWorkflowExecution({ ...params, input: { message: "different" } }, ctx.db),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
  expect(await reservations(f.authority.id)).toBe(1);
});

function holdCatalogLock(tenant_id: string, ms: number) {
  let held!: () => void;
  const acquired = new Promise<void>((resolve) => {
    held = resolve;
  });
  const done = ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenant_id}::text, 741937))`,
    );
    held();
    await tx.execute(sql`SELECT pg_sleep(${ms / 1000})`);
  });
  return { acquired, done };
}

test("admission waits for a briefly held tenant catalog lock instead of retrying", async () => {
  const f = await fixture(2);
  const warn = spyOn(logger, "warn");
  try {
    const holder = holdCatalogLock(f.params.tenant_id, 300);
    await holder.acquired;
    const admitted = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
    await holder.done;
    expect(admitted.status).toBe("queued");
    expect(warn.mock.calls.filter((call) => call[0]?.action === "retry_transient")).toHaveLength(0);
  } finally {
    warn.mockRestore();
  }
});

test("the catalog lock wait is bounded and restores the transaction lock timeout", async () => {
  const f = await fixture(1);
  const holder = holdCatalogLock(f.params.tenant_id, 400);
  await holder.acquired;
  await expect(
    ctx.db.transaction((tx) => lockCatalogVocabulary(tx, f.params.tenant_id, 50)),
  ).rejects.toBeInstanceOf(CatalogVocabularyBusyError);
  await holder.done;
  const timeout = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '7s', true)`);
    await lockCatalogVocabulary(tx, f.params.tenant_id, 50);
    const result = await tx.execute<{ lock_timeout: string }>(
      sql`SELECT current_setting('lock_timeout') AS lock_timeout`,
    );
    return result.rows[0]?.lock_timeout;
  });
  expect(timeout).toBe("7s");
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

test("nested input violations cannot create executions or consume approved runs", async () => {
  const f = await fixture(1, {
    type: "object",
    required: ["context"],
    additionalProperties: false,
    properties: {
      context: {
        type: "object",
        required: ["metadata"],
        additionalProperties: false,
        properties: {
          metadata: {
            type: "object",
            required: ["count"],
            additionalProperties: false,
            properties: { count: { type: "integer", minimum: 0, maximum: 8 } },
          },
        },
      },
    },
  });
  for (const input of [
    { context: { metadata: { count: 1, unexpected: true } } },
    { context: { metadata: {} } },
    { context: { metadata: { count: 9 } } },
    { context: { metadata: { count: 1.5 } } },
    { context: [] },
  ]) {
    await expect(
      admitAuthorizedWorkflowExecution({ ...f.params, input }, ctx.db),
    ).rejects.toMatchObject({ code: "input_schema_violation" });
    expect(await reservations(f.authority.id)).toBe(0);
    expect(
      await ctx.db.select().from(executions).where(eq(executions.tenant_id, f.params.tenant_id)),
    ).toHaveLength(0);
    expect(
      await ctx.db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.tenant_id, f.params.tenant_id)),
    ).toHaveLength(0);
  }
});
