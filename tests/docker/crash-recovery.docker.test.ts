import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import {
  composeDown,
  containerDatabaseUrl,
  crashAndRestartEngineContainer,
  type DockerEnv,
  dockerApi,
  dockerBoot,
} from "./_harness.ts";

let env: DockerEnv;

beforeAll(async () => {
  env = await dockerBoot();
}, 600_000);

afterAll(() => {
  composeDown();
}, 180_000);

async function eventually<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(200);
  }
  throw new Error(message);
}

describe("engine crash recovery", () => {
  test("hard-kills an owned engine during a durable running wait and recovers it on boot", async () => {
    const suffix = process.pid.toString(36);
    const workflow = await dockerApi<{ id: string }>(env, "POST", "/v1/workflows", {
      name: `Crash recovery ${suffix}`,
      slug: `crash-recovery-${suffix}`,
      timeout_ms: 10_000,
      steps: [{ id: "durable_wait", kind: "wait", duration_ms: 60_000 }],
    });
    expect(workflow.status).toBe(201);

    const queued = await dockerApi<{ execution_id: string }>(env, "POST", "/v1/executions", {
      source: "saved",
      workflow_id: workflow.body.id,
      input: {},
      async: true,
      request_source: "api",
    });
    expect(queued.status).toBe(202);

    const executionId = queued.body.execution_id;
    await eventually(async () => {
      const execution = await dockerApi<{ status: string }>(
        env,
        "GET",
        `/v1/executions/${executionId}`,
      );
      const steps = await dockerApi<{
        items: Array<{
          kind: string;
          status: string;
          started_at: string | null;
          request_meta: unknown;
        }>;
      }>(env, "GET", `/v1/executions/${executionId}/steps`);
      const wait = steps.body.items.find((step) => step.kind === "wait");
      return execution.status === 200 &&
        execution.body.status === "running" &&
        wait?.status === "running" &&
        wait.started_at
        ? wait
        : undefined;
    }, "execution never reached a durable running wait before hard kill");

    const client = new pg.Client({ connectionString: containerDatabaseUrl() });
    await client.connect();
    env.baseUrl = await crashAndRestartEngineContainer({
      afterKill: async () => {
        const running = await client.query<{ status: string }>(
          "SELECT status FROM subkit.executions WHERE id=$1",
          [executionId],
        );
        const step = await client.query<{ status: string }>(
          "SELECT status FROM subkit.execution_steps WHERE execution_id=$1 AND step_key='durable_wait'",
          [executionId],
        );
        const audit = await client.query(
          "SELECT 1 FROM subkit.audit_log WHERE action='execution.crash_recovered' AND resource_id=$1",
          [executionId],
        );
        expect(running.rows).toEqual([{ status: "running" }]);
        expect(step.rows).toEqual([{ status: "running" }]);
        expect(audit.rows).toEqual([]);
        await Bun.sleep(15_100);
      },
    });

    const recovered = await eventually(async () => {
      const response = await dockerApi<{ status: string; error: { code: string } | null }>(
        env,
        "GET",
        `/v1/executions/${executionId}`,
      );
      return response.status === 200 && response.body.status === "timed_out"
        ? response.body
        : undefined;
    }, "crashed execution was not terminalized after owned engine restart");
    expect(recovered.error).toEqual({ code: "engine_crash_recovery" });

    const steps = await dockerApi<{
      items: Array<{ step_key: string; status: string; error: { code?: string } | null }>;
    }>(env, "GET", `/v1/executions/${executionId}/steps`);
    expect(steps.status).toBe(200);
    expect(steps.body.items).toContainEqual(
      expect.objectContaining({
        step_key: "durable_wait",
        status: "timed_out",
        error: expect.objectContaining({ code: "timed_out" }),
      }),
    );

    try {
      const audit = await client.query<{ actor_type: string; result: string; reason: string }>(
        `SELECT actor_type, result, reason FROM subkit.audit_log
         WHERE action='execution.crash_recovered' AND resource_id=$1
         ORDER BY ts DESC LIMIT 1`,
        [executionId],
      );
      expect(audit.rows).toEqual([
        { actor_type: "system", result: "success", reason: "engine_crash_recovery" },
      ]);
    } finally {
      await client.end();
    }
  }, 180_000);
});
