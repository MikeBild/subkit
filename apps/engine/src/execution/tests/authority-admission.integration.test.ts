import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction } from "../../audit/types.ts";
import { getConnectorForEnvironment } from "../../connectors/service.ts";
import { secretNames } from "../../credentials/connections/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import {
  CatalogVocabularyBusyError,
  waitForCatalogVocabulary,
} from "../../db/catalog-vocabulary.ts";
import {
  auditLog,
  connectors,
  credentials,
  executionSteps,
  executions,
  outboundConnections,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import { logger } from "../../logging/logger.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/queues.ts";
import { createSecretVersion } from "../../runtime-config/service.ts";
import { SchedulerReconciler } from "../../scheduler/reconciler.ts";
import { retryCatalogConflict } from "../../test-helpers/catalog-retry.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createMockServer, jsonResponse } from "../../test-helpers/mock-http.ts";
import { authorityConnectorDigest } from "../../workflows/authority-configuration.ts";
import { authorityLive } from "../../workflows/authority-live.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../authority-admission.ts";
import { bindExistingRun } from "../bound-run.ts";
import type { CallerContext } from "../caller-context.ts";
import { createExecution } from "../state.ts";
import { runRequestStep } from "../steps/request.ts";
import type { StepRunContext } from "../types.ts";

let ctx: TestDb;
let counter = 0;
const actor = "00000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  ctx = await createTestDb("authority_admission");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(
  max_runs: number | null = 2,
  input_schema?: object,
  valid_until?: Date | null,
  request?: { base_url: string; driver: "http" | "graphql"; credential?: boolean | "connection" },
) {
  const slug = `authority-admission-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug,
      display_name: slug,
      driver: request?.driver ?? "http",
      auth_type:
        request?.credential === "connection" ? "oauth2" : request?.credential ? "bearer" : "none",
      environment: "dev",
      base_url: request?.base_url ?? "https://example.test/api",
    })
    .returning();
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow || !connector) throw new Error("missing workflow fixture");
  if (request?.credential)
    await upsertCredential(
      {
        tenant_id: tenant.id,
        connector_id: connector.id,
        environment: "dev",
        mode: request.credential === "connection" ? "oauth2" : "bearer",
        actor_id: null,
        value:
          request.credential === "connection"
            ? { mode: "oauth2", access_token: "connection-placeholder", token_type: "Bearer" }
            : { mode: "bearer", token: "approved-fixture-token" },
      },
      ctx.db,
    );
  let connection: typeof outboundConnections.$inferSelect | null = null;
  if (request?.credential === "connection") {
    const secret = await createSecretVersion(ctx.db, {
      name: secretNames(tenant.id, slug).access,
      value: "approved-connection-token",
      created_by: null,
    });
    const [row] = await ctx.db
      .insert(outboundConnections)
      .values({
        tenant_id: tenant.id,
        name: slug,
        base_url: request.base_url,
        issuer: request.base_url,
        authorization_endpoint: `${request.base_url}/authorize`,
        token_endpoint: `${request.base_url}/token`,
        client_id: "fixture-client",
        scopes: ["read", "write"],
        granted_scopes: ["read", "write"],
        access_token_version: secret.version,
      })
      .returning();
    if (!row) throw new Error("missing connection fixture");
    connection = row;
    await ctx.db
      .update(credentials)
      .set({ connection_id: row.id })
      .where(and(eq(credentials.tenant_id, tenant.id), eq(credentials.connector_id, connector.id)));
  }
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
            ...(request?.driver === "graphql"
              ? {
                  graphql: { operation: "mutation", query: "mutation { sendReport { id } }" },
                }
              : {}),
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
  const [authority] = await ctx.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: {
        targets: preview.manifest.effects.flatMap((effect) =>
          effect.target ? [effect.target] : [],
        ),
      },
      execution_environment: "dev",
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: valid_until === undefined ? new Date(now.getTime() + 60 * 60_000) : valid_until,
      max_runs,
      created_by: actor,
    })
    .returning();
  if (!authority) throw new Error("missing authority fixture");
  return {
    authority,
    connector,
    connection,
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
    code: "execution_authority_unavailable",
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
    code: "execution_authority_unavailable",
  });
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, queued.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_unavailable" });
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
  expect(held[0]?.reason).toBe("execution_authority_unavailable");
  expect((held[0]?.metadata as Record<string, unknown> | undefined)?.reason_code).toBe(
    "execution_authority_unavailable",
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
    await new Promise((resolve) => setTimeout(resolve, ms));
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
    ctx.db.transaction((tx) => waitForCatalogVocabulary(tx, f.params.tenant_id, 50)),
  ).rejects.toBeInstanceOf(CatalogVocabularyBusyError);
  await holder.done;
  const timeout = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '7s', true)`);
    await waitForCatalogVocabulary(tx, f.params.tenant_id, 50);
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

test("dispatch matches its exact step and captured configuration, even after the database is restored", async () => {
  const f = await fixture();
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  const connector = await getConnectorForEnvironment(
    f.params.tenant_id,
    f.connector.id,
    "dev",
    ctx.db,
  );
  if (!connector) throw new Error("missing resolved connector");
  const snapshot = {
    step_id: "send",
    configuration_digest: authorityConnectorDigest(connector),
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
  };
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, snapshot);
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, {
      ...snapshot,
      connection_authority: { id: actor, revision: 1 },
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  const changed = { ...connector, base_url: "https://changed.example.test" };
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, {
      ...snapshot,
      configuration_digest: authorityConnectorDigest(changed),
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id, {
      ...snapshot,
      step_id: "unapproved-step",
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
});

for (const driver of ["http", "graphql"] as const) {
  test(`${driver} binds loaded configuration and credentials and never follows an unapproved redirect`, async () => {
    let sent = 0;
    let redirect = false;
    const remote = await createMockServer((req, res) => {
      sent++;
      if (redirect && req.url !== "/unapproved") {
        res.writeHead(307, { location: "/unapproved" });
        res.end();
        return;
      }
      jsonResponse(res, 200, { ok: true, data: { sendReport: { id: "receipt" } } });
    });
    try {
      for (const change of [
        "none",
        "configuration",
        "credential",
        "credential_missing",
        "redirect",
        "connection_valid",
        "connection_changed",
      ] as const) {
        const changed = change !== "none" && change !== "connection_valid";
        redirect = change === "redirect";
        const f = await fixture(2, undefined, undefined, {
          base_url: remote.baseUrl,
          driver,
          credential: change.startsWith("connection") ? "connection" : true,
        });
        const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
        if (change === "connection_changed") {
          if (!f.connection) throw new Error("missing connection fixture");
          await ctx.db
            .update(outboundConnections)
            .set({ authority_revision: 2, granted_scopes: ["read", "write", "admin"] })
            .where(
              and(
                eq(outboundConnections.tenant_id, f.params.tenant_id),
                eq(outboundConnections.id, f.connection.id),
              ),
            );
        }
        const [originalCredential] = await ctx.db
          .select()
          .from(credentials)
          .where(
            and(
              eq(credentials.tenant_id, f.params.tenant_id),
              eq(credentials.connector_id, f.connector.id),
            ),
          );
        if (!originalCredential) throw new Error("missing credential fixture");
        if (change === "credential_missing")
          await ctx.db
            .update(credentials)
            .set({ deleted_at: await databaseNow(ctx.db) })
            .where(eq(credentials.id, originalCredential.id));
        if (change === "credential")
          await upsertCredential(
            {
              tenant_id: f.params.tenant_id,
              connector_id: f.connector.id,
              environment: "dev",
              mode: "bearer",
              actor_id: null,
              value: { mode: "bearer", token: "unapproved-fixture-token" },
            },
            ctx.db,
          );
        const step = WorkflowDefSchema.parse(f.version.dag).steps[0];
        if (step?.kind !== "request") throw new Error("missing request fixture");
        const [stepRow] = await ctx.db
          .insert(executionSteps)
          .values({
            tenant_id: f.params.tenant_id,
            execution_id: run.execution_id,
            step_key: step.id,
            step_index: 0,
            kind: "request",
            status: "running",
          })
          .returning();
        if (!stepRow) throw new Error("missing step fixture");
        if (change === "configuration")
          await ctx.db
            .update(connectors)
            .set({ base_url: `${remote.baseUrl}/changed` })
            .where(eq(connectors.id, f.connector.id));
        let checked = 0;
        const context: StepRunContext = {
          db: ctx.db,
          tenant_id: f.params.tenant_id,
          execution_id: run.execution_id,
          workflow_id: f.workflow.id,
          workflow_version_id: f.version.id,
          request_source: "api",
          parent_execution_id: null,
          depth: 0,
          signal: new AbortController().signal,
          scope: {},
          started_at: new Date(getTestNow()),
          workflow_slug: f.workflow.slug,
          trace_id: null,
          principal: null,
          execution_mode: "dev",
          step,
          step_index: 0,
          step_row_id: stepRow.id,
          persist_workflow_refs: true,
          llm_budget: new RunLlmBudget(null),
          before_external_request: async (snapshot) => {
            checked++;
            if (change === "credential_missing") {
              expect(snapshot.credential_id).toBeNull();
              await ctx.db
                .update(credentials)
                .set({ deleted_at: null })
                .where(eq(credentials.id, originalCredential.id));
            }
            if (change === "connection_changed") {
              if (!f.connection) throw new Error("missing connection fixture");
              expect(snapshot.connection_authority).toEqual({ id: f.connection.id, revision: 2 });
              await ctx.db
                .update(outboundConnections)
                .set({
                  authority_revision: f.connection.authority_revision,
                  granted_scopes: f.connection.granted_scopes,
                })
                .where(
                  and(
                    eq(outboundConnections.tenant_id, f.params.tenant_id),
                    eq(outboundConnections.id, f.connection.id),
                  ),
                );
            }
            if (change === "configuration")
              await ctx.db
                .update(connectors)
                .set({ base_url: f.connector.base_url })
                .where(eq(connectors.id, f.connector.id));
            if (change === "credential")
              await ctx.db
                .update(credentials)
                .set({
                  ciphertext: originalCredential.ciphertext,
                  iv: originalCredential.iv,
                  auth_tag: originalCredential.auth_tag,
                  authority_revision: originalCredential.authority_revision,
                })
                .where(
                  and(
                    eq(credentials.tenant_id, f.params.tenant_id),
                    eq(credentials.id, originalCredential.id),
                  ),
                );
            return await assertExecutionAuthorityCurrent(
              ctx.db,
              f.params.tenant_id,
              run.execution_id,
              snapshot,
            );
          },
        };
        const before = sent;
        const result = await runRequestStep({ ctx: context, step, scope: {} });
        expect(checked).toBe(1);
        expect(result.status).toBe(changed ? "failed" : "succeeded");
        expect(sent - before).toBe(changed && !redirect ? 0 : 1);
        if (changed)
          expect(result.error?.code).toBe(
            redirect ? "authority_redirect_denied" : "execution_authority_changed",
          );
      }
    } finally {
      await remote.close();
    }
  });
}

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
  const expires = new Date((await databaseNow(ctx.db)).getTime() + 3_000);
  const f = await fixture(1, undefined, expires);
  const run = await admitAuthorizedWorkflowExecution(f.params, ctx.db);
  await assertExecutionAuthorityCurrent(ctx.db, f.params.tenant_id, run.execution_id);
  await waitFor(async () => (await databaseNow(ctx.db)).getTime() >= expires.getTime(), {
    tries: 200,
    sleepMs: 25,
    label: "PostgreSQL crosses the immutable authority deadline",
  });
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
