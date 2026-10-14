import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction } from "../../audit/types.ts";
import { auditLog, executionSteps, executions, users } from "../../db/schema/index.ts";
import type { CallerOrigin } from "../../execution/caller-origin.ts";
import { createExecution } from "../../execution/state.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createBoss, disposeBoss } from "../boss.ts";
import { registerExecutionRunHandler } from "../handlers/execution-run.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";

let engineCtx: EngineTestCtx;
let mockSrv: MockServer;
let boss: PgBoss;
const nextUuid = createDeterministicUuidFactory(0x9a0e2026);

beforeAll(async () => {
  engineCtx = await createEngineCtx("runjob");
  mockSrv = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { ok: true, value: 42 });
  });
  boss = await createBoss({ connectionString: engineCtx.testDb.url });
  await registerExecutionRunHandler({ boss, db: engineCtx.testDb.db });
});

afterAll(async () => {
  await disposeBoss(boss);
  await mockSrv.close();
  await engineCtx.cleanup();
});

describe("queue: execution.run worker", () => {
  async function authRefusalActor(
    caller_context: unknown,
    slug: string,
    request_source: RequestSource = "api",
    queue_request_source: RequestSource = request_source,
    provenance: { origin?: CallerOrigin; historical?: boolean; spoofedOrigin?: CallerOrigin } = {},
  ) {
    const [user] = await engineCtx.testDb.db
      .insert(users)
      .values({
        tenant_id: engineCtx.tenantId,
        email: `${slug}@test.local`,
        role_id: await builtinRoleId(engineCtx.testDb.db, "admin"),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("caller user missing");
    const { workflow_id, version_id } = await createWorkflowRow(engineCtx, {
      name: slug,
      slug,
      steps: [{ id: "send", kind: "request", method: "POST", url: `${mockSrv.baseUrl}/denied` }],
    });
    const storedCaller =
      typeof caller_context === "object" &&
      caller_context !== null &&
      "principalId" in caller_context &&
      "tenantId" in caller_context &&
      caller_context.tenantId === engineCtx.tenantId
        ? { ...caller_context, principalId: user.id }
        : null;
    const execution_id = await createExecution(engineCtx.testDb.db, {
      tenant_id: engineCtx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      source_kind: "saved",
      source_ref: null,
      request_source,
      hold_writes: true,
      caller_context: storedCaller as never,
      ...(!provenance.historical ? { caller_origin: "principal" as const } : {}),
      authorization_context: null,
    });
    if (storedCaller === null && caller_context !== null)
      await engineCtx.testDb.db
        .update(executions)
        .set({ caller_context: caller_context as never, caller_origin: "principal" })
        .where(and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)));
    if (provenance.origin)
      await engineCtx.testDb.db
        .update(executions)
        .set({ caller_origin: provenance.origin })
        .where(and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)));
    await boss.send(
      EXECUTION_RUN_QUEUE,
      {
        tenant_id: engineCtx.tenantId,
        workflow_id,
        execution_id,
        input: null,
        request_source: queue_request_source,
        ...(provenance.spoofedOrigin ? { caller_origin: provenance.spoofedOrigin } : {}),
      } satisfies ExecutionRunJob,
      { id: execution_id },
    );
    await waitFor(
      async () => {
        const [current] = await engineCtx.testDb.db
          .select({ status: executions.status })
          .from(executions)
          .where(
            and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)),
          );
        return current?.status === "failed" ? current : null;
      },
      { tries: 150, sleepMs: 200, label: `${slug} authorization refusal` },
    );
    const [refusal] = await engineCtx.testDb.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, AuditAction.POLICY_DENIED), eq(auditLog.resource_id, execution_id)),
      );
    return {
      refusal: refusal ? { actor_type: refusal.actor_type, actor_id: refusal.actor_id } : undefined,
      request_source:
        refusal && typeof refusal.metadata === "object" && refusal.metadata !== null
          ? (refusal.metadata as Record<string, unknown>).request_source
          : undefined,
      userId: user.id,
      execution_id,
    };
  }

  test("authorization refusal does not attribute a caller from another tenant", async () => {
    const { refusal } = await authRefusalActor(
      {
        tenantId: nextUuid(),
        principalId: nextUuid(),
        principalKind: "user",
        provider: "api_key",
        productId: null,
      },
      "cross-tenant-auth-refusal",
    );
    expect(refusal).toEqual({ actor_type: "unknown", actor_id: null });
  }, 40_000);

  test("authorization refusal retains a same-tenant persisted caller actor", async () => {
    const { refusal, userId } = await authRefusalActor(
      {
        tenantId: engineCtx.tenantId,
        principalId: nextUuid(),
        principalKind: "user",
        provider: "api_key",
        productId: null,
      },
      "same-tenant-auth-refusal",
      "api",
      "scheduler",
      { spoofedOrigin: "trusted_system" },
    );
    expect(refusal).toEqual({ actor_type: "user", actor_id: userId });
  }, 40_000);

  test("authorization refusal retains the persisted request source", async () => {
    const { request_source } = await authRefusalActor(
      {
        tenantId: engineCtx.tenantId,
        principalId: nextUuid(),
        principalKind: "user",
        provider: "mcp_oauth",
        productId: null,
      },
      "mcp-auth-refusal-source",
      "mcp",
      "api",
    );
    expect(request_source).toBe("mcp");
  }, 40_000);

  test("malformed persisted caller context is recorded as unknown on authorization refusal", async () => {
    const { refusal } = await authRefusalActor(
      { tenantId: engineCtx.tenantId, principalKind: "user" },
      "malformed-auth-refusal",
    );
    expect(refusal).toEqual({ actor_type: "unknown", actor_id: null });
  }, 40_000);

  for (const origin of ["unknown", "trusted_system"] as const) {
    test(`authorization refusal keeps ${origin} provenance unknown despite a valid caller and spoofed job`, async () => {
      const { refusal } = await authRefusalActor(
        {
          tenantId: engineCtx.tenantId,
          principalId: nextUuid(),
          principalKind: "user",
          provider: "api_key",
          productId: null,
        },
        `${origin}-auth-refusal`,
        "api",
        "scheduler",
        {
          historical: true,
          ...(origin === "trusted_system" ? { origin } : {}),
          spoofedOrigin: "principal",
        },
      );
      expect(refusal).toEqual({ actor_type: "unknown", actor_id: null });
    }, 40_000);
  }

  test("admission refusal retains a valid persisted caller actor", async () => {
    const [user] = await engineCtx.testDb.db
      .insert(users)
      .values({
        tenant_id: engineCtx.tenantId,
        email: "caller-admission@test.local",
        role_id: await builtinRoleId(engineCtx.testDb.db, "admin"),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("caller user missing");
    const { workflow_id, version_id } = await createWorkflowRow(engineCtx, {
      name: "caller-without-authority",
      slug: "caller-without-authority",
      steps: [{ id: "send", kind: "request", method: "POST", url: `${mockSrv.baseUrl}/denied` }],
    });
    const execution_id = await createExecution(engineCtx.testDb.db, {
      tenant_id: engineCtx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "mcp",
      caller_origin: "principal",
      caller_context: {
        tenantId: engineCtx.tenantId,
        principalId: user.id,
        principalKind: "user",
        provider: "api_key",
        productId: null,
      },
    });
    await boss.send(
      EXECUTION_RUN_QUEUE,
      {
        tenant_id: engineCtx.tenantId,
        workflow_id,
        execution_id,
        input: null,
        request_source: "api",
      } satisfies ExecutionRunJob,
      { id: execution_id },
    );
    const row = await waitFor(
      async () => {
        const [current] = await engineCtx.testDb.db
          .select()
          .from(executions)
          .where(
            and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)),
          );
        return current?.status === "failed" ? current : null;
      },
      { tries: 150, sleepMs: 200, label: "caller admission refusal" },
    );
    expect(row.status).toBe("failed");

    const [refusal] = await engineCtx.testDb.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "execution.boundary_refused"),
          eq(auditLog.resource_id, execution_id),
        ),
      );
    expect(refusal).toMatchObject({
      actor_type: "user",
      actor_id: user.id,
      metadata: { request_source: "mcp" },
    });
  }, 40_000);

  test("admission refusal does not attribute a caller from another tenant", async () => {
    const [user] = await engineCtx.testDb.db
      .insert(users)
      .values({
        tenant_id: engineCtx.tenantId,
        email: "cross-tenant-caller-admission@test.local",
        role_id: await builtinRoleId(engineCtx.testDb.db, "admin"),
      })
      .returning({ id: users.id });
    if (!user) throw new Error("caller user missing");
    const { workflow_id, version_id } = await createWorkflowRow(engineCtx, {
      name: "cross-tenant-caller-without-authority",
      slug: "cross-tenant-caller-without-authority",
      steps: [{ id: "send", kind: "request", method: "POST", url: `${mockSrv.baseUrl}/denied` }],
    });
    const execution_id = await createExecution(engineCtx.testDb.db, {
      tenant_id: engineCtx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
    });
    await engineCtx.testDb.db
      .update(executions)
      .set({
        caller_origin: "principal",
        caller_context: {
          tenantId: nextUuid(),
          principalId: user.id,
          principalKind: "user",
          provider: "api_key",
          productId: null,
        },
      })
      .where(and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)));
    await boss.send(
      EXECUTION_RUN_QUEUE,
      {
        tenant_id: engineCtx.tenantId,
        workflow_id,
        execution_id,
        input: null,
        request_source: "api",
      } satisfies ExecutionRunJob,
      { id: execution_id },
    );
    const row = await waitFor(
      async () => {
        const [current] = await engineCtx.testDb.db
          .select()
          .from(executions)
          .where(
            and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)),
          );
        return current?.status === "failed" ? current : null;
      },
      { tries: 150, sleepMs: 200, label: "cross-tenant caller admission refusal" },
    );
    expect(row.status).toBe("failed");

    const [refusal] = await engineCtx.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "execution.boundary_refused"),
          eq(auditLog.resource_id, execution_id),
        ),
      );
    expect(refusal).toEqual({ actor_type: "unknown", actor_id: null });
  }, 40_000);

  test("a legacy queued write without authority fails without dispatch", async () => {
    let writes = 0;
    mockSrv.setHandler((request, res) => {
      if (request.method === "POST") writes++;
      jsonResponse(res, 200, { ok: true });
    });
    const { workflow_id, version_id } = await createWorkflowRow(engineCtx, {
      name: "legacy-unbound",
      slug: "legacy-unbound",
      steps: [{ id: "send", kind: "request", method: "POST", url: `${mockSrv.baseUrl}/legacy` }],
    });
    const execution_id = await createExecution(engineCtx.testDb.db, {
      tenant_id: engineCtx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
    });
    await boss.send(
      EXECUTION_RUN_QUEUE,
      {
        tenant_id: engineCtx.tenantId,
        workflow_id,
        execution_id,
        input: null,
        request_source: "api",
      } satisfies ExecutionRunJob,
      { id: execution_id },
    );
    const row = await waitFor(
      async () => {
        const [current] = await engineCtx.testDb.db
          .select()
          .from(executions)
          .where(
            and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)),
          );
        return current?.status === "failed" ? current : null;
      },
      { tries: 150, sleepMs: 200, label: "legacy queue denial" },
    );
    expect(row).toMatchObject({
      status: "failed",
      hold_writes: false,
      execution_authority_id: null,
    });
    expect(writes).toBe(0);
    expect(
      await engineCtx.testDb.db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.execution_id, execution_id)),
    ).toHaveLength(0);

    const refusals = await engineCtx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "execution.boundary_refused"),
          eq(auditLog.resource_id, execution_id),
        ),
      );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.result).toBe("denied");
    expect(refusals[0]?.reason).toBe("execution_authority_required");
    expect((refusals[0]?.metadata as Record<string, unknown> | undefined)?.stage).toBe("admission");
  });

  test("a persisted preparation stays held when the real queue envelope omits hold options", async () => {
    let writes = 0;
    mockSrv.setHandler((request, res) => {
      if (request.method === "POST") writes++;
      jsonResponse(res, 200, { ok: true });
    });
    const { workflow_id, version_id } = await createWorkflowRow(engineCtx, {
      name: "queued-preview",
      slug: "queued-preview",
      steps: [{ id: "send", kind: "request", method: "POST", url: `${mockSrv.baseUrl}/held` }],
    });
    const execution_id = await createExecution(engineCtx.testDb.db, {
      tenant_id: engineCtx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
      hold_writes: true,
    });
    await boss.send(
      EXECUTION_RUN_QUEUE,
      {
        tenant_id: engineCtx.tenantId,
        workflow_id,
        execution_id,
        input: null,
        request_source: "api",
      } satisfies ExecutionRunJob,
      { id: execution_id },
    );
    const row = await waitFor(
      async () => {
        const [current] = await engineCtx.testDb.db
          .select()
          .from(executions)
          .where(
            and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)),
          );
        return current && !["queued", "running"].includes(current.status) ? current : null;
      },
      { tries: 150, sleepMs: 200, label: "queued preparation completion" },
    );
    expect(row).toMatchObject({ status: "succeeded", hold_writes: true });
    const steps = await engineCtx.testDb.db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, engineCtx.tenantId),
          eq(executionSteps.execution_id, execution_id),
        ),
      );
    expect(steps).toHaveLength(1);
    expect(writes).toBe(0);
  }, 40_000);

  for (const origin of ["unknown", "trusted_system"] as const) {
    test(`async worker keeps persisted ${origin} provenance despite spoofed job fields`, async () => {
      const { workflow_id, version_id } = await createWorkflowRow(engineCtx, {
        name: `enqueue-${origin}`,
        slug: `enqueue-${origin}`,
        steps: [
          {
            id: "req",
            kind: "request",
            method: "GET",
            url: `${mockSrv.baseUrl}/ping`,
          },
        ],
      });
      const execution_id = await createExecution(engineCtx.testDb.db, {
        tenant_id: engineCtx.tenantId,
        workflow_id,
        workflow_version_id: version_id,
        source_kind: "saved",
        source_ref: null,
        request_source: "api",
        parent_execution_id: null,
        input: { hello: "world", caller_origin: "principal" },
        ...(origin === "trusted_system" ? { caller_origin: origin } : {}),
        hold_writes: true,
      });

      const job: ExecutionRunJob = {
        tenant_id: engineCtx.tenantId,
        workflow_id,
        execution_id,
        input: { hello: "world", caller_origin: "principal" },
        request_source: "scheduler",
        ...{ caller_origin: origin === "unknown" ? "trusted_system" : "principal" },
      };
      const jobId = await boss.send(EXECUTION_RUN_QUEUE, job);
      expect(jobId).toBeTruthy();

      const db = engineCtx.testDb.db;
      const completed = await waitFor(
        async () => {
          const [current] = await db
            .select()
            .from(executions)
            .where(
              and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)),
            );
          const [terminal] = await db
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.tenant_id, engineCtx.tenantId),
                eq(auditLog.resource_id, execution_id),
                eq(auditLog.action, AuditAction.EXECUTION_COMPLETED),
              ),
            );
          return current?.status === "succeeded" && terminal ? current : null;
        },
        { tries: 150, sleepMs: 200, label: `${origin} worker lifecycle completion` },
      );
      expect(completed.status).toBe("succeeded");
      const [persisted] = await db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, engineCtx.tenantId), eq(executions.id, execution_id)));
      expect(persisted?.request_source).toBe("api");
      expect(persisted?.caller_origin).toBe(origin);
      expect(persisted?.caller_context).toBeNull();
      const audits = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.tenant_id, engineCtx.tenantId), eq(auditLog.resource_id, execution_id)),
        );
      for (const action of [
        AuditAction.EXECUTION_QUEUED,
        AuditAction.EXECUTION_STARTED,
        AuditAction.EXECUTION_COMPLETED,
      ]) {
        expect(audits.filter((row) => row.action === action)).toHaveLength(1);
        expect(audits.find((row) => row.action === action)).toMatchObject({
          actor_type: origin === "trusted_system" ? "system" : "unknown",
          actor_id: null,
          metadata:
            action === AuditAction.EXECUTION_COMPLETED
              ? { final_status: "succeeded" }
              : { request_source: "api" },
        });
      }
    }, 90_000);
  }
});
