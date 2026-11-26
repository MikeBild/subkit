import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  deviceRunners,
  deviceWaits,
  executions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { listExecutions } from "../execution/list.ts";
import { createExecution } from "../execution/state.ts";
import {
  boss,
  call,
  enroll,
  heartbeat,
  nextId,
  type Runner,
  sent,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../http/tests/device-runner-fixtures.ts";
import type { HttpTestServer } from "../http/tests/setup.ts";
import { buildAttention, invalidateAttention } from "../operator/attention.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import { EXECUTION_RUN_DEVICE_QUEUE } from "../queue/queues.ts";
import { revokeDevice } from "./registry.ts";
import {
  admitDeviceRun,
  deviceRunPlan,
  enqueueExecutionRun,
  onDeviceLifecycle,
  readmitWaitingRun,
  startDeviceRun,
} from "./waiting.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await setUpDeviceRunner("device_waiting");
});

afterAll(async () => {
  await tearDownDeviceRunner();
});

async function deviceRun(runner: Runner, offline: "wait" | "fail" = "wait", validMs?: number) {
  const n = nextId();
  const [workflow] = await server.db
    .insert(workflows)
    .values({
      tenant_id: server.tenantId,
      slug: `device-run-${n}`,
      name: `Device run ${n}`,
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow fixture");
  const [version] = await server.db
    .insert(workflowVersions)
    .values({
      tenant_id: server.tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: { name: workflow.name, device_offline: offline, steps: [] },
    })
    .returning();
  if (!version) throw new Error("version fixture");
  await server.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  const [authority] = await server.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: server.tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: "a".repeat(64),
      effect_manifest: {
        effects: [
          { effect: "write", device: { device_id: runner.device_id, capability: "files" } },
        ],
      },
      execution_environment: "prod",
      target_constraints: { targets: [] },
      created_by: server.userId,
      ...(validMs === undefined ? {} : { valid_until: new Date(Date.now() + validMs) }), // allow-wall-clock: authority validity
    })
    .returning();
  if (!authority) throw new Error("authority fixture");
  const execution_id = await createExecution(server.db, {
    tenant_id: server.tenantId,
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    execution_authority_id: authority.id,
    source_kind: "saved",
    source_ref: null,
    request_source: "scheduler",
    execution_mode: "prod",
  });
  return {
    execution_id,
    job: { tenant_id: server.tenantId, workflow_id: workflow.id, execution_id },
  };
}

async function executionStatus(execution_id: string) {
  const [row] = await server.db
    .select({ status: executions.status, failure: executions.failure })
    .from(executions)
    .where(and(eq(executions.tenant_id, server.tenantId), eq(executions.id, execution_id)));
  return row;
}

async function offline(runner: Runner) {
  await server.db
    .update(deviceRunners)
    .set({ last_heartbeat_at: sql`clock_timestamp() - interval '10 minutes'` })
    .where(eq(deviceRunners.id, runner.device_id));
}

describe("a device that is offline", () => {
  test("an online device gets the run on its own queue, writes never retried", async () => {
    const runner = await enroll("Online (Mike)");
    await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(0));
    const run = await deviceRun(runner);
    sent.length = 0;
    expect(await enqueueExecutionRun(server.db, boss, run.job)).toBe("queued");
    expect(sent[0]?.name).toBe("execution.run.device");
    expect(sent[0]?.options.retryLimit).toBe(0);
    expect(sent[0]?.options.expireInSeconds).toBe(3600);
    expect(await startDeviceRun(server.db, boss, run.job)).toBe(true);
  });

  test("the run waits without a job, raises attention after 15 minutes and resumes on the heartbeat", async () => {
    const runner = await enroll("Away (Mike)");
    const run = await deviceRun(runner);
    sent.length = 0;
    expect(await enqueueExecutionRun(server.db, boss, run.job)).toBe("waiting");
    expect((await executionStatus(run.execution_id))?.status).toBe("waiting_for_device");
    expect(sent.map((job) => job.name)).toEqual(["device.wait", "device.wait"]);
    expect(sent.some((job) => job.name === "execution.run.device")).toBe(false);

    const principal = {
      kind: "user",
      id: server.userId,
      tenant_id: server.tenantId,
      roles: ["admin"],
    };
    const before = await buildAttention(server.db, principal as never, {
      now: new Date(Date.now()), // allow-wall-clock: attention instant
    });
    expect(before.items.some((item) => item.reason === "device_offline_waiting")).toBe(false);
    invalidateAttention(server.tenantId);
    const after = await buildAttention(server.db, principal as never, {
      now: new Date(Date.now() + 16 * 60_000), // allow-wall-clock: attention instant
    });
    const item = after.items.find((entry) => entry.reason === "device_offline_waiting");
    expect(item?.subject).toEqual({ kind: "device", id: runner.device_id, name: "Away (Mike)" });
    const href = item?.actions[0]?.href ?? "";
    expect(href).toBe(
      `/cockpit?runs=all&runs_status=waiting_for_device&runs_device=${runner.device_id}`,
    );
    const listed = await listExecutions(
      server.tenantId,
      { status: "waiting_for_device", device_id: runner.device_id },
      server.db,
    );
    expect(listed.rows.map((row) => row.id)).toEqual([run.execution_id]);
    const elsewhere = await listExecutions(
      server.tenantId,
      { status: "waiting_for_device", device_id: "00000000-0000-4000-8000-0000000000ff" },
      server.db,
    );
    expect(elsewhere.rows).toHaveLength(0);

    sent.length = 0;
    await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(0));
    const online = {
      tenant_id: server.tenantId,
      type: "device.online",
      payload: { device_id: runner.device_id },
    };
    const resumed = await Promise.all([
      onDeviceLifecycle(server.db, boss, online),
      onDeviceLifecycle(server.db, boss, online),
    ]);
    expect(resumed[0] + resumed[1]).toBe(1);
    expect((await executionStatus(run.execution_id))?.status).toBe("queued");
    expect(sent.map((job) => job.name)).toEqual(["execution.run.device"]);
    const waits = await server.db
      .select()
      .from(deviceWaits)
      .where(eq(deviceWaits.execution_id, run.execution_id));
    expect(waits).toHaveLength(0);
  });

  test("the device dropping before the job starts puts the run back to waiting", async () => {
    const runner = await enroll("Drop (Mike)");
    await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(0));
    const run = await deviceRun(runner);
    await enqueueExecutionRun(server.db, boss, run.job);
    await offline(runner);
    expect(await startDeviceRun(server.db, boss, run.job)).toBe(false);
    expect((await executionStatus(run.execution_id))?.status).toBe("waiting_for_device");
  });

  test("a workflow that does not wait fails at once with a remedy", async () => {
    const runner = await enroll("Fail (Mike)");
    const run = await deviceRun(runner, "fail");
    expect(await enqueueExecutionRun(server.db, boss, run.job)).toBe("failed");
    const row = await executionStatus(run.execution_id);
    expect(row?.status).toBe("failed");
    expect(row?.failure?.error_code).toBe("device_offline");
    expect(row?.failure?.error_message).toContain("Open SubKit on “Fail (Mike)”");
  });

  test("the wait never outlasts the approval: the cap fails it with device_offline_timeout", async () => {
    const runner = await enroll("Cap (Mike)");
    const run = await deviceRun(runner, "wait", 60_000);
    const plan = await deviceRunPlan(server.db, server.tenantId, run.execution_id);
    if (!plan) throw new Error("no plan");
    expect(await admitDeviceRun(server.db, boss, plan, run.job)).toBe("waiting");
    const [wait] = await server.db
      .select({ cap_at: deviceWaits.cap_at })
      .from(deviceWaits)
      .where(eq(deviceWaits.execution_id, run.execution_id));
    expect(plan.authority_valid_until?.getTime()).toBe(wait?.cap_at.getTime());
    expect(
      await admitDeviceRun(server.db, boss, plan, run.job, "resume", () => Date.now() + 61_000), // allow-wall-clock: past the cap
    ).toBe("failed");
    expect((await executionStatus(run.execution_id))?.failure?.error_code).toBe(
      "device_offline_timeout",
    );
  });

  test("revoking the device fails its waiting runs", async () => {
    const runner = await enroll("Gone (Mike)");
    const run = await deviceRun(runner);
    await enqueueExecutionRun(server.db, boss, run.job);
    expect(
      await revokeDevice(
        server.db,
        { tenant_id: server.tenantId, user_id: server.userId, may_revoke_any: true },
        runner.device_id,
      ),
    ).toBe(true);
    await onDeviceLifecycle(server.db, boss, {
      tenant_id: server.tenantId,
      type: "device.offline",
      payload: { device_id: runner.device_id },
    });
    expect((await executionStatus(run.execution_id))?.failure?.error_code).toBe("device_revoked");
  });

  test("a job that starts for a run already running is not run again", async () => {
    const runner = await enroll("Crash (Mike)");
    const run = await deviceRun(runner);
    await server.db
      .update(executions)
      .set({ status: "running", started_at: new Date(Date.now()) }) // allow-wall-clock: run start
      .where(eq(executions.id, run.execution_id));
    expect(await startDeviceRun(server.db, boss, run.job, 0)).toBe(false);
    expect((await executionStatus(run.execution_id))?.status).toBe("running");
    expect(await startDeviceRun(server.db, boss, run.job, 1)).toBe(false);
    expect((await executionStatus(run.execution_id))?.failure?.error_code).toBe(
      "device_step_interrupted",
    );
  });
});

describe("one pending device job per run", () => {
  const pendingJobs = async (queue: Awaited<ReturnType<typeof createBoss>>, id: string) =>
    queue.findJobs(EXECUTION_RUN_DEVICE_QUEUE, { data: { execution_id: id }, queued: true });

  test("enqueuing the same run again, also at once, sends a single device job", async () => {
    const queue = await createBoss({ connectionString: server.testDb.url });
    try {
      const runner = await enroll("Twice (Mike)");
      await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(0));
      const run = await deviceRun(runner);
      expect(await enqueueExecutionRun(server.db, queue, run.job)).toBe("queued");
      expect(await enqueueExecutionRun(server.db, queue, run.job)).toBe("queued");
      expect(await pendingJobs(queue, run.execution_id)).toHaveLength(1);
      const racing = await deviceRun(runner);
      expect(
        await Promise.all([
          enqueueExecutionRun(server.db, queue, racing.job),
          enqueueExecutionRun(server.db, queue, racing.job),
          enqueueExecutionRun(server.db, queue, racing.job),
        ]),
      ).toEqual(["queued", "queued", "queued"]);
      expect(await pendingJobs(queue, racing.execution_id)).toHaveLength(1);
    } finally {
      await disposeBoss(queue);
    }
  });

  test("a run that waited after its job was taken gets a fresh job on resume", async () => {
    const queue = await createBoss({ connectionString: server.testDb.url });
    try {
      const runner = await enroll("Again (Mike)");
      await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(0));
      const run = await deviceRun(runner);
      await enqueueExecutionRun(server.db, queue, run.job);
      const taken = (await queue.fetch(EXECUTION_RUN_DEVICE_QUEUE, { batchSize: 100 })).find(
        (job) => (job.data as { execution_id?: string }).execution_id === run.execution_id,
      );
      if (!taken) throw new Error("missing device job");
      await offline(runner);
      expect(await startDeviceRun(server.db, queue, run.job)).toBe(false);
      await queue.complete(EXECUTION_RUN_DEVICE_QUEUE, taken.id);
      expect(await pendingJobs(queue, run.execution_id)).toHaveLength(0);
      await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(0));
      expect(await readmitWaitingRun(server.db, queue, server.tenantId, run.execution_id)).toBe(
        "queued",
      );
      const fresh = await pendingJobs(queue, run.execution_id);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.id).not.toBe(taken.id);
    } finally {
      await disposeBoss(queue);
    }
  });
});
