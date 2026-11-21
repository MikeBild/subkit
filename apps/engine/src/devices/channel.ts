import {
  capabilityOfKind,
  type DeviceCommand,
  type DeviceCommandKind,
  type DeviceRefusal,
  type DeviceResult,
  DeviceResultSchema,
} from "@shared/device/protocol.ts";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { type DEVICE_LOSS_CODES, deviceEffectAuditMetadata } from "../audit/device-metadata.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { deviceCommands, deviceRunners } from "../db/schema/index.ts";
import {
  protectExecutionPayload,
  recoverExecutionPayload,
} from "../execution/sensitive-payload.ts";
import {
  type ClosureState,
  claimVerdict,
  type DeviceCommandState,
  OPEN_COMMAND_STATES,
  resultVerdict,
} from "./core/command-state.ts";
import { nextCommandGeneration } from "./core/generation.ts";
import { commandEffect } from "./core/offline-policy.ts";
import type { RunnerIdentity } from "./runner-auth.ts";
import { committedImport } from "./uploads.ts";

export type DeviceCommandRow = typeof deviceCommands.$inferSelect;

export class DeviceChannelError extends Error {
  constructor(
    readonly code: "device_revoked",
    message: string,
  ) {
    super(message);
  }
}

export interface NewDeviceCommand {
  command_id: string;
  tenant_id: string;
  device_id: string;
  execution_id: string | null;
  task_run_id: string | null;
  conversation_id?: string | null;
  step_id: string;
  authority_id: string | null;
  manifest_digest: string | null;
  kind: DeviceCommandKind;
  args: unknown;
  deadline_at: Date;
}

type Device = Pick<RunnerIdentity, "tenant_id" | "device_id">;
type AuditCode = DeviceRefusal | (typeof DEVICE_LOSS_CODES)[number];

const ARGS_SLOT = "device_args";
const RESULT_SLOT = "device_result";

function commandWhere(device: Device, command_id: string) {
  return and(
    eq(deviceCommands.tenant_id, device.tenant_id),
    eq(deviceCommands.device_id, device.device_id),
    eq(deviceCommands.id, command_id),
  );
}

export async function emitCommandEvent(
  tx: Executor,
  row: Pick<DeviceCommandRow, "tenant_id" | "device_id" | "id" | "execution_id" | "task_run_id">,
  state: DeviceCommandState,
): Promise<void> {
  await writeEvent(tx, {
    tenant_id: row.tenant_id,
    channel: "resource.lifecycle",
    type: "device.command",
    payload: {
      device_id: row.device_id,
      command_id: row.id,
      command_state: state,
      ...(row.execution_id ? { execution_id: row.execution_id } : {}),
      ...(row.task_run_id ? { task_run_id: row.task_run_id } : {}),
    },
  });
}

async function deviceLabel(tx: Executor, device: Device): Promise<string> {
  const [row] = await tx
    .select({ label: deviceRunners.device_label })
    .from(deviceRunners)
    .where(
      and(eq(deviceRunners.tenant_id, device.tenant_id), eq(deviceRunners.id, device.device_id)),
    )
    .limit(1);
  return row?.label ?? "device";
}

async function auditCommand(
  tx: Executor,
  row: DeviceCommandRow,
  action: (typeof AuditAction)[
    | "DEVICE_COMMAND_COMPLETED"
    | "DEVICE_COMMAND_REFUSED"
    | "DEVICE_COMMAND_LOST"],
  outcome: { result: "success" | "denied" | "error"; code?: AuditCode; actor_id: string | null },
): Promise<void> {
  const device = { tenant_id: row.tenant_id, device_id: row.device_id };
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: outcome.actor_id ? "user" : "system",
      actor_id: outcome.actor_id,
      action,
      resource_type: "device_command",
      resource_id: row.id,
      result: outcome.result,
      ...(outcome.code ? { reason: outcome.code } : {}),
      metadata: deviceEffectAuditMetadata(
        {
          device_id: row.device_id,
          device_label: await deviceLabel(tx, device),
          capability: capabilityOfKind(row.kind),
          command_id: row.id,
          generation: row.generation,
          ...(row.execution_id ? { execution_id: row.execution_id } : {}),
          ...(row.task_run_id ? { task_run_id: row.task_run_id } : {}),
          ...(outcome.code ? { code: outcome.code } : {}),
        },
        "standard",
      ),
    },
    tx,
  );
}

export async function openDeviceCommand(
  db: Db,
  input: NewDeviceCommand,
): Promise<DeviceCommandRow> {
  return db.transaction(async (tx) => {
    const [device] = await tx
      .select({ stop_generation: deviceRunners.stop_generation })
      .from(deviceRunners)
      .where(
        and(
          eq(deviceRunners.tenant_id, input.tenant_id),
          eq(deviceRunners.id, input.device_id),
          isNull(deviceRunners.revoked_at),
        ),
      )
      .for("share")
      .limit(1);
    const [existing] = await tx
      .select()
      .from(deviceCommands)
      .where(commandWhere(input, input.command_id))
      .limit(1);
    if (existing) return existing;
    if (!device)
      throw new DeviceChannelError("device_revoked", "the device is no longer connected");
    const [created] = await tx
      .insert(deviceCommands)
      .values({
        id: input.command_id,
        tenant_id: input.tenant_id,
        device_id: input.device_id,
        execution_id: input.execution_id,
        task_run_id: input.task_run_id,
        conversation_id: input.conversation_id ?? null,
        step_id: input.step_id,
        authority_id: input.authority_id,
        manifest_digest: input.manifest_digest,
        kind: input.kind,
        effect: commandEffect(input.kind),
        args: protectExecutionPayload(input.args, input.tenant_id, input.command_id, ARGS_SLOT),
        state: "pending",
        generation: nextCommandGeneration(device.stop_generation),
        deadline_at: input.deadline_at,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [raced] = await tx
        .select()
        .from(deviceCommands)
        .where(commandWhere(input, input.command_id))
        .limit(1);
      if (!raced) throw new Error("device command was neither created nor found");
      return raced;
    }
    await emitCommandEvent(tx, created, "pending");
    return created;
  });
}

export async function reopenLostRead(
  db: Db,
  row: DeviceCommandRow,
  deadline_at: Date,
): Promise<DeviceCommandRow | null> {
  return db.transaction(async (tx) => {
    const [device] = await tx
      .select({ stop_generation: deviceRunners.stop_generation })
      .from(deviceRunners)
      .where(
        and(
          eq(deviceRunners.tenant_id, row.tenant_id),
          eq(deviceRunners.id, row.device_id),
          isNull(deviceRunners.revoked_at),
        ),
      )
      .for("share")
      .limit(1);
    if (!device) return null;
    const [reopened] = await tx
      .update(deviceCommands)
      .set({
        state: "pending",
        attempt: sql`${deviceCommands.attempt} + 1`,
        generation: nextCommandGeneration(device.stop_generation),
        deadline_at,
        claimed_at: null,
        last_progress_at: null,
        finished_at: null,
      })
      .where(
        and(
          commandWhere(row, row.id),
          eq(deviceCommands.state, "lost"),
          eq(deviceCommands.effect, "read"),
          eq(deviceCommands.attempt, row.attempt),
        ),
      )
      .returning();
    if (reopened) await emitCommandEvent(tx, reopened, "pending");
    return reopened ?? null;
  });
}

export function commandForRunner(row: DeviceCommandRow): DeviceCommand {
  return {
    command_id: row.id,
    tenant_id: row.tenant_id,
    execution_id: row.execution_id,
    task_run_id: row.task_run_id,
    conversation_id: row.conversation_id,
    step_id: row.step_id,
    authority_id: row.authority_id,
    manifest_digest: row.manifest_digest,
    kind: row.kind,
    args: recoverExecutionPayload(row.args, row.tenant_id, row.id, ARGS_SLOT),
    deadline_at: row.deadline_at.toISOString(),
    generation: row.generation,
    confirmation: null,
  };
}

export function storedResult(row: DeviceCommandRow): DeviceResult | null {
  if (!row.result) return null;
  const parsed = DeviceResultSchema.safeParse(
    recoverExecutionPayload(row.result, row.tenant_id, row.id, RESULT_SLOT),
  );
  return parsed.success ? parsed.data : null;
}

async function closeRow(
  tx: Executor,
  row: DeviceCommandRow,
  closure: ClosureState,
): Promise<DeviceCommandRow | null> {
  const [closed] = await tx
    .update(deviceCommands)
    .set({ state: closure, finished_at: sql`clock_timestamp()` })
    .where(and(commandWhere(row, row.id), inArray(deviceCommands.state, [...OPEN_COMMAND_STATES])))
    .returning();
  if (!closed) return null;
  await emitCommandEvent(tx, closed, closure);
  if (closure === "lost")
    await auditCommand(tx, closed, AuditAction.DEVICE_COMMAND_LOST, {
      result: "error",
      code: closed.effect === "write" ? "device_lost_during_write" : "device_step_interrupted",
      actor_id: null,
    });
  return closed;
}

export async function closeDeviceCommand(
  db: Db,
  row: DeviceCommandRow,
  closure: ClosureState,
): Promise<DeviceCommandRow | null> {
  return db.transaction((tx) => closeRow(tx, row, closure));
}

export type ClaimOutcome =
  | { ok: true; command: DeviceCommand }
  | { ok: false; status: 404 | 409; code: string };

export async function claimDeviceCommand(
  db: Db,
  runner: Device,
  command_id: string,
  now_ms: number,
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(deviceCommands)
      .where(commandWhere(runner, command_id))
      .for("update")
      .limit(1);
    if (!row) return { ok: false, status: 404, code: "command_not_found" };
    const [device] = await tx
      .select({ stop_generation: deviceRunners.stop_generation })
      .from(deviceRunners)
      .where(
        and(eq(deviceRunners.tenant_id, runner.tenant_id), eq(deviceRunners.id, runner.device_id)),
      )
      .limit(1);
    const verdict = claimVerdict(
      { state: row.state, deadline_at_ms: row.deadline_at.getTime(), generation: row.generation },
      now_ms,
      device?.stop_generation ?? Number.MAX_SAFE_INTEGER,
    );
    if (!verdict.ok) {
      if ("close" in verdict) await closeRow(tx, row, verdict.close);
      return { ok: false, status: 409, code: verdict.reason };
    }
    const [claimed] = await tx
      .update(deviceCommands)
      .set({ state: "claimed", claimed_at: sql`clock_timestamp()` })
      .where(and(commandWhere(runner, command_id), eq(deviceCommands.state, "pending")))
      .returning();
    if (!claimed) return { ok: false, status: 409, code: "already_claimed" };
    await emitCommandEvent(tx, claimed, "claimed");
    return { ok: true, command: commandForRunner(claimed) };
  });
}

export async function recordCommandProgress(
  db: Db,
  runner: Device,
  command_id: string,
): Promise<{ ok: true } | { ok: false; status: 404 | 409 }> {
  const [row] = await db
    .update(deviceCommands)
    .set({ last_progress_at: sql`clock_timestamp()` })
    .where(and(commandWhere(runner, command_id), eq(deviceCommands.state, "claimed")))
    .returning({ id: deviceCommands.id });
  if (row) return { ok: true };
  const [known] = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(commandWhere(runner, command_id))
    .limit(1);
  return { ok: false, status: known ? 409 : 404 };
}

export type ResultOutcome =
  | { ok: true; stored: boolean; state: DeviceCommandState; kind: string }
  | { ok: false; status: 404 };

const RESULT_AUDIT = {
  done: { action: AuditAction.DEVICE_COMMAND_COMPLETED, result: "success" },
  failed: { action: AuditAction.DEVICE_COMMAND_COMPLETED, result: "error" },
  refused: { action: AuditAction.DEVICE_COMMAND_REFUSED, result: "denied" },
} as const;

async function importVerified(
  tx: Executor,
  row: DeviceCommandRow,
  result: DeviceResult,
): Promise<boolean> {
  if (row.kind !== "files.import" || result.status !== "done") return true;
  const file_id = (result.output as { file_id?: unknown } | null)?.file_id;
  return typeof file_id === "string" && (await committedImport(tx, row.tenant_id, row.id, file_id));
}

export async function recordCommandResult(
  db: Db,
  runner: Device & { owner_user_id: string },
  command_id: string,
  reported: DeviceResult,
): Promise<ResultOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(deviceCommands)
      .where(commandWhere(runner, command_id))
      .for("update")
      .limit(1);
    if (!row) return { ok: false, status: 404 };
    const result: DeviceResult = (await importVerified(tx, row, reported))
      ? reported
      : {
          status: "failed",
          code: "import_unverified",
          detail: "The device named a file this command did not import. Nothing was kept.",
        };
    const verdict = resultVerdict(row.state, result);
    if (!verdict.store) return { ok: true, stored: false, state: row.state, kind: row.kind };
    const [stored] = await tx
      .update(deviceCommands)
      .set({
        state: verdict.state,
        result: protectExecutionPayload(result, row.tenant_id, row.id, RESULT_SLOT),
        finished_at: sql`clock_timestamp()`,
      })
      .where(commandWhere(runner, command_id))
      .returning();
    if (!stored) throw new Error("device command result was not stored");
    await emitCommandEvent(tx, stored, verdict.state);
    const audit =
      result.status in RESULT_AUDIT
        ? RESULT_AUDIT[result.status as keyof typeof RESULT_AUDIT]
        : null;
    if (audit)
      await auditCommand(tx, stored, audit.action, {
        result: audit.result,
        ...(result.status === "refused" ? { code: result.code } : {}),
        actor_id: runner.owner_user_id,
      });
    return { ok: true, stored: true, state: verdict.state, kind: row.kind };
  });
}

export async function closeStoppedCommands(
  tx: Executor,
  device: Device,
  stop_generation: number,
): Promise<number> {
  const closed = await tx
    .update(deviceCommands)
    .set({ state: "stopped", finished_at: sql`clock_timestamp()` })
    .where(
      and(
        eq(deviceCommands.tenant_id, device.tenant_id),
        eq(deviceCommands.device_id, device.device_id),
        inArray(deviceCommands.state, [...OPEN_COMMAND_STATES]),
        lt(deviceCommands.generation, stop_generation),
      ),
    )
    .returning();
  for (const row of closed) await emitCommandEvent(tx, row, "stopped");
  return closed.length;
}

export async function closeRevokedCommands(tx: Executor, device: Device): Promise<number> {
  const closed = await tx
    .update(deviceCommands)
    .set({ state: "revoked", finished_at: sql`clock_timestamp()` })
    .where(
      and(
        eq(deviceCommands.tenant_id, device.tenant_id),
        eq(deviceCommands.device_id, device.device_id),
        inArray(deviceCommands.state, [...OPEN_COMMAND_STATES]),
      ),
    )
    .returning();
  for (const row of closed) await emitCommandEvent(tx, row, "revoked");
  return closed.length;
}

export async function pendingCommandIds(db: Db, device: Device): Promise<string[]> {
  const rows = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.tenant_id, device.tenant_id),
        eq(deviceCommands.device_id, device.device_id),
        eq(deviceCommands.state, "pending"),
      ),
    )
    .orderBy(deviceCommands.created_at)
    .limit(200);
  return rows.map((row) => row.id);
}

export interface CommandWatch {
  row: DeviceCommandRow;
  last_heartbeat_at: Date | null;
}

export async function watchCommand(
  db: Db,
  device: Device,
  command_id: string,
): Promise<CommandWatch | null> {
  const [found] = await db
    .select({ row: deviceCommands, last_heartbeat_at: deviceRunners.last_heartbeat_at })
    .from(deviceCommands)
    .innerJoin(
      deviceRunners,
      and(
        eq(deviceRunners.tenant_id, deviceCommands.tenant_id),
        eq(deviceRunners.id, deviceCommands.device_id),
      ),
    )
    .where(commandWhere(device, command_id))
    .limit(1);
  return found ?? null;
}

export async function openCommandsOfExecution(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<DeviceCommandRow[]> {
  return db
    .select()
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.tenant_id, tenant_id),
        eq(deviceCommands.execution_id, execution_id),
        inArray(deviceCommands.state, [...OPEN_COMMAND_STATES]),
      ),
    );
}

export async function closeCommandsOfExecution(
  tx: Executor,
  tenant_id: string,
  execution_id: string,
  closure: ClosureState,
): Promise<number> {
  const rows = await openCommandsOfExecution(tx, tenant_id, execution_id);
  let closed = 0;
  for (const row of rows) if (await closeRow(tx, row, closure)) closed += 1;
  return closed;
}
