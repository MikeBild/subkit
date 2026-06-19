// Enqueue an execution.run job and wait for the worker to consume it +
// mark the execution row as succeeded.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { executions } from "../../db/schema/index.ts";
import { createExecution } from "../../execution/state.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
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
  await disposeBoss(boss, 5_000);
  await mockSrv.close();
  await engineCtx.cleanup();
});

describe("queue: execution.run worker", () => {
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
    // HTTP layer would pre-create the execution row; mimic that here.
    const execution_id = await createExecution(engineCtx.testDb.db, {
      tenant_id: engineCtx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
      parent_execution_id: null,
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

    // Poll until the execution row reaches a terminal status.
    // 60s budget: pg-boss worker polls at 1s, and when the whole suite runs
    // in parallel each per-test database races to register ~14 queues.
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
