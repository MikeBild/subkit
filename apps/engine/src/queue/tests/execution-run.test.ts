import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditLog, executionSteps, executions } from "../../db/schema/index.ts";
import { createExecution } from "../../execution/state.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createBoss, disposeBoss } from "../boss.ts";
import { registerExecutionRunHandler } from "../handlers/execution-run.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";

let engineCtx: EngineTestCtx;
let mockSrv: MockServer;
let boss: PgBoss;

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

  test("async enqueue -> worker runs engine -> execution succeeds", async () => {
    const { workflow_id, version_id } = await createWorkflowRow(engineCtx, {
      name: "enqueue-me",
      slug: "enqueue-me",
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
      input: { hello: "world" },
      hold_writes: true,
    });

    const job: ExecutionRunJob = {
      tenant_id: engineCtx.tenantId,
      workflow_id,
      execution_id,
      input: { hello: "world" },
      request_source: "api",
    };
    const jobId = await boss.send(EXECUTION_RUN_QUEUE, job);
    expect(jobId).toBeTruthy();

    const db = engineCtx.testDb.db;
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 60_000;
    let finalStatus = "";
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (Date.now() < deadline) {
      const rows = await db.select().from(executions).where(eq(executions.id, execution_id));
      finalStatus = rows[0]?.status ?? "";
      if (["succeeded", "failed", "aborted", "timed_out"].includes(finalStatus)) break;
      await new Promise((r) => setTimeout(r, 200)); // allow-wall-clock: pg-boss dequeue cadence — the worker poll interval is real time
    }
    expect(finalStatus).toBe("succeeded");
  }, 90_000);
});
