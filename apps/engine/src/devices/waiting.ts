import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { Db, Executor } from "../db/client.ts";
import {
  deviceRunners,
  deviceWaits,
  executions,
  workflowExecutionAuthorities,
  workflowVersions,
} from "../db/schema/index.ts";
import { finalizeExecution } from "../execution/state.ts";
import { errorFields, logger } from "../logging/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import type { EventEnvelope } from "../pubsub/types.ts";
import { enqueueHostedWork } from "../queue/hosted-work.ts";
import {
  DEVICE_WAIT_QUEUE,
  type DeviceWaitJob,
  EXECUTION_RUN_DEVICE_QUEUE,
  EXECUTION_RUN_QUEUE,
  type ExecutionRunJob,
} from "../queue/queues.ts";
import { closeCommandsOfExecution } from "./channel.ts";
import {
  admissionVerdict,
  DEVICE_ONLINE_WINDOW_MS,
  deviceRetryLimit,
  type ManifestEffect,
  type OfflinePolicy,
  unavailableMessage,
} from "./core/offline-policy.ts";
import { expireScreenshots } from "./screenshot-retention.ts";
import { expireUploads } from "./uploads.ts";

const DEVICE_RUN_EXPIRY_SECONDS = 60 * 60;

const ManifestEffectsSchema = z.object({
  effects: z.array(
    z
      .object({
        effect: z.enum(["read", "write", "unknown", "destructive"]),
        device: z.object({ device_id: z.string().uuid() }).passthrough().optional(),
      })
      .passthrough(),
  ),
});

export interface DeviceRunPlan {
  tenant_id: string;
  execution_id: string;
  workflow_id: string | null;
  device_id: string;
  effects: ManifestEffect[];
  policy: OfflinePolicy;
  authority_valid_until: Date | null;
}

export async function deviceRunPlan(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<DeviceRunPlan | null> {
  const [row] = await db
    .select({
      workflow_id: executions.workflow_id,
      manifest: workflowExecutionAuthorities.effect_manifest,
      valid_until: workflowExecutionAuthorities.valid_until,
      dag: workflowVersions.dag,
    })
    .from(executions)
    .innerJoin(
      workflowExecutionAuthorities,
      and(
        eq(workflowExecutionAuthorities.tenant_id, executions.tenant_id),
        eq(workflowExecutionAuthorities.id, executions.execution_authority_id),
      ),
    )
    .leftJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, executions.tenant_id),
        eq(workflowVersions.id, executions.workflow_version_id),
      ),
    )
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  if (!row) return null;
  const parsed = ManifestEffectsSchema.safeParse(row.manifest);
  if (!parsed.success) return null;
  const local = parsed.data.effects.filter((effect) => effect.device);
  const device_id = local.map((effect) => effect.device?.device_id ?? "").sort()[0];
  if (!device_id) return null;
  const offline = (row.dag as { device_offline?: unknown } | null)?.device_offline;
  return {
    tenant_id,
    execution_id,
    workflow_id: row.workflow_id,
    device_id,
    effects: local.map((effect) => effect.effect),
    policy: offline === "fail" ? "fail" : "wait",
    authority_valid_until: row.valid_until,
  };
}

interface DeviceStanding {
  revoked: boolean;
  online: boolean;
  label: string;
}

async function deviceStanding(db: Executor, plan: DeviceRunPlan): Promise<DeviceStanding> {
  const [row] = await db
    .select({
      revoked: sql<boolean>`${deviceRunners.revoked_at} IS NOT NULL`,
      online: sql<boolean>`coalesce(${deviceRunners.last_heartbeat_at} > clock_timestamp() - (${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond'), false)`,
      label: deviceRunners.device_label,
    })
    .from(deviceRunners)
    .where(and(eq(deviceRunners.tenant_id, plan.tenant_id), eq(deviceRunners.id, plan.device_id)))
    .limit(1);
  return row ?? { revoked: true, online: false, label: "device" };
}

async function waitingSince(db: Executor, plan: DeviceRunPlan): Promise<Date | null> {
  const [row] = await db
    .select({ since: deviceWaits.waiting_since })
    .from(deviceWaits)
    .where(
      and(
        eq(deviceWaits.tenant_id, plan.tenant_id),
        eq(deviceWaits.execution_id, plan.execution_id),
      ),
    )
    .limit(1);
  return row?.since ?? null;
}

export async function clearDeviceWait(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<void> {
  await db
    .delete(deviceWaits)
    .where(and(eq(deviceWaits.tenant_id, tenant_id), eq(deviceWaits.execution_id, execution_id)));
}

export function deviceRunSendOptions(plan: DeviceRunPlan) {
  return {
    id: randomUUID(),
    retryLimit: deviceRetryLimit(plan.effects),
    expireInSeconds: DEVICE_RUN_EXPIRY_SECONDS,
  };
}

export type DeviceAdmission = "queued" | "waiting" | "failed" | "settled";
type AdmissionMode = "admit" | "resume" | "start";

async function enterWait(
  db: Db,
  boss: PgBoss,
  plan: DeviceRunPlan,
  since: Date,
  verdict: { cap_at_ms: number; attention_at_ms: number },
): Promise<boolean> {
  const entered = await db.transaction(async (tx) => {
    const [moved] = await tx
      .update(executions)
      .set({ status: "waiting_for_device" })
      .where(
        and(
          eq(executions.tenant_id, plan.tenant_id),
          eq(executions.id, plan.execution_id),
          inArray(executions.status, ["queued", "waiting_for_device"]),
        ),
      )
      .returning({ id: executions.id });
    if (!moved) return false;
    const [inserted] = await tx
      .insert(deviceWaits)
      .values({
        execution_id: plan.execution_id,
        tenant_id: plan.tenant_id,
        device_id: plan.device_id,
        waiting_since: since,
        cap_at: new Date(verdict.cap_at_ms),
      })
      .onConflictDoNothing()
      .returning({ id: deviceWaits.execution_id });
    if (inserted)
      await emitResourceChange(tx, {
        tenant_id: plan.tenant_id,
        type: "execution.waiting_for_device",
        ids: {
          execution_id: plan.execution_id,
          workflow_id: plan.workflow_id,
          device_id: plan.device_id,
        },
      });
    return Boolean(inserted);
  });
  if (entered) {
    const base = { tenant_id: plan.tenant_id, execution_id: plan.execution_id };
    await boss.send(DEVICE_WAIT_QUEUE, { ...base, phase: "attention" } satisfies DeviceWaitJob, {
      startAfter: new Date(verdict.attention_at_ms),
      singletonKey: `attention:${plan.execution_id}`,
    });
    await boss.send(DEVICE_WAIT_QUEUE, { ...base, phase: "expire" } satisfies DeviceWaitJob, {
      startAfter: new Date(verdict.cap_at_ms),
      singletonKey: `expire:${plan.execution_id}`,
    });
  }
  return entered;
}

async function leaveWait(db: Db, plan: DeviceRunPlan, mode: AdmissionMode): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: executions.status })
      .from(executions)
      .where(and(eq(executions.tenant_id, plan.tenant_id), eq(executions.id, plan.execution_id)))
      .for("update")
      .limit(1);
    if (!row) return false;
    await clearDeviceWait(tx, plan.tenant_id, plan.execution_id);
    if (row.status === "queued") return mode !== "resume";
    if (row.status !== "waiting_for_device") return false;
    await tx
      .update(executions)
      .set({ status: "queued" })
      .where(and(eq(executions.tenant_id, plan.tenant_id), eq(executions.id, plan.execution_id)));
    return true;
  });
}

async function failUnavailable(
  db: Db,
  plan: DeviceRunPlan,
  code: "device_offline" | "device_offline_timeout" | "device_revoked",
  label: string,
): Promise<void> {
  await clearDeviceWait(db, plan.tenant_id, plan.execution_id);
  await finalizeExecution(
    db,
    plan.tenant_id,
    plan.execution_id,
    { type: "device_unavailable" },
    {
      failure: { step_id: null, error_code: code, error_message: unavailableMessage(code, label) },
    },
  );
}

export async function admitDeviceRun(
  db: Db,
  boss: PgBoss,
  plan: DeviceRunPlan,
  job: ExecutionRunJob,
  mode: AdmissionMode = "admit",
  now: () => number = Date.now,
): Promise<DeviceAdmission> {
  const standing = await deviceStanding(db, plan);
  const since = (await waitingSince(db, plan)) ?? new Date(now());
  const verdict = admissionVerdict(
    {
      revoked: standing.revoked,
      online: standing.online,
      policy: plan.policy,
      waiting_since_ms: since.getTime(),
      authority_valid_until_ms: plan.authority_valid_until?.getTime() ?? null,
    },
    now(),
  );
  if (verdict.kind === "fail") {
    await failUnavailable(db, plan, verdict.code, standing.label);
    return "failed";
  }
  if (verdict.kind === "dispatch") {
    if (!(await leaveWait(db, plan, mode))) return "settled";
    if (mode === "start") return "queued";
    await enqueueHostedWork(
      db,
      boss,
      "execution",
      EXECUTION_RUN_DEVICE_QUEUE,
      job,
      deviceRunSendOptions(plan),
    );
    return "queued";
  }
  if (!(await enterWait(db, boss, plan, since, verdict))) return "settled";
  const after = await deviceStanding(db, plan);
  if (after.online || after.revoked) return admitDeviceRun(db, boss, plan, job, "resume", now);
  return "waiting";
}

export async function enqueueExecutionRun(
  db: Db,
  boss: PgBoss,
  job: ExecutionRunJob & { execution_id: string },
): Promise<DeviceAdmission> {
  const plan = await deviceRunPlan(db, job.tenant_id, job.execution_id);
  if (!plan) {
    await enqueueHostedWork(db, boss, "execution", EXECUTION_RUN_QUEUE, job, {
      id: job.execution_id,
    });
    return "queued";
  }
  return admitDeviceRun(db, boss, plan, job);
}

async function waitingJob(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<ExecutionRunJob | null> {
  const [row] = await db
    .select({
      workflow_id: executions.workflow_id,
      request_source: executions.request_source,
      execution_mode: executions.execution_mode,
      status: executions.status,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  if (!row?.workflow_id || row.status !== "waiting_for_device") return null;
  return {
    tenant_id,
    workflow_id: row.workflow_id,
    execution_id,
    request_source: row.request_source,
    execution_mode: row.execution_mode,
  };
}

export async function readmitWaitingRun(
  db: Db,
  boss: PgBoss,
  tenant_id: string,
  execution_id: string,
): Promise<DeviceAdmission> {
  const job = await waitingJob(db, tenant_id, execution_id);
  if (!job) {
    await clearDeviceWait(db, tenant_id, execution_id);
    return "settled";
  }
  const plan = await deviceRunPlan(db, tenant_id, execution_id);
  if (!plan) {
    await finalizeExecution(
      db,
      tenant_id,
      execution_id,
      { type: "device_unavailable" },
      {
        failure: {
          step_id: null,
          error_code: "execution_authority_required",
          error_message: "The approval for this run is gone. Nothing ran on the device.",
        },
      },
    );
    await clearDeviceWait(db, tenant_id, execution_id);
    return "failed";
  }
  return admitDeviceRun(db, boss, plan, job, "resume");
}

export async function resumeWaitingRuns(
  db: Db,
  boss: PgBoss,
  tenant_id: string,
  device_id: string,
): Promise<number> {
  const waits = await db
    .select({ execution_id: deviceWaits.execution_id })
    .from(deviceWaits)
    .where(and(eq(deviceWaits.tenant_id, tenant_id), eq(deviceWaits.device_id, device_id)))
    .orderBy(deviceWaits.waiting_since)
    .limit(500);
  let moved = 0;
  for (const wait of waits) {
    try {
      const admitted = await readmitWaitingRun(db, boss, tenant_id, wait.execution_id);
      if (admitted === "queued" || admitted === "failed") moved += 1;
    } catch (error) {
      logger.error({
        module: "devices",
        action: "device_wait.resume_failed",
        msg: "a run waiting for its device could not be resumed",
        tenant_id,
        execution_id: wait.execution_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return moved;
}

export async function handleDeviceWaitJob(db: Db, boss: PgBoss, job: DeviceWaitJob): Promise<void> {
  if (job.phase === "upload_expire") {
    await expireUploads(db, job.tenant_id, new Date());
    return;
  }
  if (job.phase === "screenshot_expire") {
    await expireScreenshots(db, job.tenant_id, new Date());
    return;
  }
  if (job.phase === "expire") {
    await readmitWaitingRun(db, boss, job.tenant_id, job.execution_id);
    return;
  }
  const waiting = await waitingJob(db, job.tenant_id, job.execution_id);
  if (!waiting) return;
  const [wait] = await db
    .select({ device_id: deviceWaits.device_id })
    .from(deviceWaits)
    .where(
      and(eq(deviceWaits.tenant_id, job.tenant_id), eq(deviceWaits.execution_id, job.execution_id)),
    )
    .limit(1);
  if (!wait) return;
  await db.transaction((tx) =>
    emitResourceChange(tx, {
      tenant_id: job.tenant_id,
      type: "execution.waiting_for_device",
      ids: {
        execution_id: job.execution_id,
        workflow_id: waiting.workflow_id,
        device_id: wait.device_id,
      },
    }),
  );
}

export async function onDeviceLifecycle(
  db: Db,
  boss: PgBoss,
  event: { tenant_id: string; type: string; payload: unknown },
): Promise<number> {
  if (event.type !== "device.online" && event.type !== "device.offline") return 0;
  const device_id = (event.payload as { device_id?: unknown } | null)?.device_id;
  if (typeof device_id !== "string") return 0;
  if (event.type === "device.offline") {
    const [device] = await db
      .select({ revoked_at: deviceRunners.revoked_at })
      .from(deviceRunners)
      .where(and(eq(deviceRunners.tenant_id, event.tenant_id), eq(deviceRunners.id, device_id)))
      .limit(1);
    if (device && device.revoked_at === null) return 0;
  }
  return resumeWaitingRuns(db, boss, event.tenant_id, device_id);
}

const INTERRUPTED_MESSAGE =
  "The run stopped while a step ran on a device. It is not run again; check on the device what was done.";

export async function interruptDeviceRun(
  db: Db,
  tenant_id: string,
  execution_id: string,
): Promise<void> {
  await db.transaction((tx) => closeCommandsOfExecution(tx, tenant_id, execution_id, "lost"));
  await clearDeviceWait(db, tenant_id, execution_id);
  await finalizeExecution(
    db,
    tenant_id,
    execution_id,
    { type: "failed" },
    {
      failure: {
        step_id: null,
        error_code: "device_step_interrupted",
        error_message: INTERRUPTED_MESSAGE,
      },
    },
  );
}

export async function startDeviceRun(
  db: Db,
  boss: PgBoss,
  job: ExecutionRunJob,
  retry_count = 0,
): Promise<boolean> {
  if (!job.execution_id) return true;
  const [row] = await db
    .select({ status: executions.status })
    .from(executions)
    .where(and(eq(executions.tenant_id, job.tenant_id), eq(executions.id, job.execution_id)))
    .limit(1);
  if (!row) return true;
  if (row.status === "running") {
    if (retry_count > 0) await interruptDeviceRun(db, job.tenant_id, job.execution_id);
    return false;
  }
  if (row.status !== "queued") return row.status !== "waiting_for_device";
  const plan = await deviceRunPlan(db, job.tenant_id, job.execution_id);
  if (!plan) return true;
  return (await admitDeviceRun(db, boss, plan, job, "start")) === "queued";
}

export function deviceLifecycleHandler(db: Db, boss: PgBoss, stopping: () => boolean) {
  return async (event: EventEnvelope) => {
    if (stopping()) return;
    try {
      await onDeviceLifecycle(db, boss, event);
    } catch (err) {
      logger.error({
        module: "devices",
        action: "device_wait.lifecycle_failed",
        msg: "runs waiting for a device were not re-admitted",
        event_id: event.id,
        ...errorFields(err),
      });
    }
  };
}
