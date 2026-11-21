import {
  capabilityOfKind,
  type DeviceCommandKind,
  type DeviceResult,
} from "@shared/device/protocol.ts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  deviceRunners,
  executions,
  workflowExecutionAuthorities,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { resolveExecutionCallerActor } from "../execution/caller-origin.ts";
import { globalEmitter } from "../pubsub/emitter.ts";
import type { EventEnvelope } from "../pubsub/types.ts";
import {
  closeDeviceCommand,
  DeviceChannelError,
  type DeviceCommandRow,
  openDeviceCommand,
  reopenLostRead,
  storedResult,
  watchCommand,
} from "./channel.ts";
import {
  type ClosureState,
  isOpenCommand,
  livenessVerdict,
  retriesAfterLoss,
} from "./core/command-state.ts";
import { commandDeadlineAt, commandEffect } from "./core/offline-policy.ts";
import {
  type LocalRunSource,
  type LocalRunTrigger,
  type LocalSourceRefusal,
  localAgenticRefusal,
} from "./core/run-source.ts";

export interface DeviceCommandRequest {
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
  source: LocalRunSource | null;
}

export interface DeviceDispatchContext {
  db: Db;
  signal: AbortSignal;
  now?: () => number;
}

export type DeviceDispatchOutcome =
  | { kind: "refused"; command_id: string; code: LocalSourceRefusal }
  | { kind: "result"; command_id: string; result: DeviceResult }
  | { kind: "closed"; command_id: string; closure: ClosureState; effect: "read" | "write" };

function wakeOn(
  tenant_id: string,
  command_id: string,
  signal: AbortSignal,
): { next: (ms: number) => Promise<void>; close: () => void } {
  let wake: (() => void) | null = null;
  let pending = false;
  const fire = () => {
    pending = true;
    wake?.();
  };
  const off = globalEmitter.on("resource.lifecycle", (event: EventEnvelope<unknown>) => {
    if (event.tenant_id !== tenant_id || event.type !== "device.command") return;
    const payload = event.payload as { command_id?: unknown } | null;
    if (payload?.command_id === command_id) fire();
  });
  signal.addEventListener("abort", fire);
  return {
    next(ms) {
      if (pending || signal.aborted) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(0, ms));
        function done() {
          clearTimeout(timer);
          wake = null;
          pending = false;
          resolve();
        }
        wake = done;
      });
    },
    close() {
      off();
      signal.removeEventListener("abort", fire);
    },
  };
}

export async function executionAuthorityPin(
  db: Db,
  tenant_id: string,
  execution_id: string,
): Promise<{ authority_id: string; manifest_digest: string; manifest: unknown } | null> {
  const [row] = await db
    .select({
      authority_id: workflowExecutionAuthorities.id,
      manifest_digest: workflowExecutionAuthorities.effect_manifest_digest,
      manifest: workflowExecutionAuthorities.effect_manifest,
    })
    .from(executions)
    .innerJoin(
      workflowExecutionAuthorities,
      and(
        eq(workflowExecutionAuthorities.tenant_id, executions.tenant_id),
        eq(workflowExecutionAuthorities.id, executions.execution_authority_id),
      ),
    )
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  return row ?? null;
}

export function sourceRefusal(
  request: Pick<DeviceCommandRequest, "kind" | "source">,
): LocalSourceRefusal | null {
  if (capabilityOfKind(request.kind) === "files") return null;
  if (!request.source) return "trigger_not_allowed";
  return localAgenticRefusal(request.source);
}

const TRIGGER_BY_SOURCE: Readonly<Record<string, LocalRunTrigger>> = {
  scheduler: "schedule",
  ui: "manual_run",
  cli: "manual_run",
  chat: "chat",
  webhook: "webhook",
  mcp: "mcp",
  api: "api",
  "tool-chain": "workflow_call",
};

export async function executionRunSource(
  db: Db,
  tenant_id: string,
  execution_id: string,
  device_id: string,
): Promise<LocalRunSource | null> {
  const [row] = await db
    .select({
      request_source: executions.request_source,
      caller: executions.caller_context,
      caller_origin: executions.caller_origin,
      parent_execution_id: executions.parent_execution_id,
      schedule_created_by: workflowsSchedules.created_by,
      device_owner: deviceRunners.owner_user_id,
    })
    .from(executions)
    .innerJoin(
      deviceRunners,
      and(eq(deviceRunners.tenant_id, executions.tenant_id), eq(deviceRunners.id, device_id)),
    )
    .leftJoin(
      workflowsSchedules,
      and(
        eq(workflowsSchedules.tenant_id, executions.tenant_id),
        eq(workflowsSchedules.workflow_id, executions.workflow_id),
      ),
    )
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  if (!row) return null;
  const actor = resolveExecutionCallerActor(tenant_id, row.caller, row.caller_origin);
  return {
    trigger: row.parent_execution_id
      ? "workflow_call"
      : (TRIGGER_BY_SOURCE[row.request_source] ?? "api"),
    started_by: actor.actor_type === "user" ? actor.actor_id : null,
    schedule_created_by: row.schedule_created_by ?? null,
    device_owner: row.device_owner,
  };
}

function closed(row: DeviceCommandRow, closure: ClosureState): DeviceDispatchOutcome {
  return { kind: "closed", command_id: row.id, closure, effect: row.effect };
}

export async function sendDeviceCommand(
  ctx: DeviceDispatchContext,
  request: DeviceCommandRequest,
): Promise<DeviceDispatchOutcome> {
  const now = ctx.now ?? Date.now;
  const device = { tenant_id: request.tenant_id, device_id: request.device_id };
  const refusal = sourceRefusal(request);
  if (refusal) return { kind: "refused", command_id: request.command_id, code: refusal };
  const waits = wakeOn(request.tenant_id, request.command_id, ctx.signal);
  try {
    try {
      await openDeviceCommand(ctx.db, {
        ...request,
        deadline_at: new Date(commandDeadlineAt(request.kind, now())),
      });
    } catch (error) {
      if (error instanceof DeviceChannelError)
        return {
          kind: "closed",
          command_id: request.command_id,
          closure: "revoked",
          effect: commandEffect(request.kind),
        };
      throw error;
    }
    for (;;) {
      const watched = await watchCommand(ctx.db, device, request.command_id);
      if (!watched) throw new Error("device command disappeared");
      const row = watched.row;
      if (!isOpenCommand(row.state)) {
        const result = storedResult(row);
        if (result) return { kind: "result", command_id: row.id, result };
        if (row.state === "done")
          return {
            kind: "result",
            command_id: row.id,
            result: {
              status: "failed",
              code: "device_result_expired",
              detail: "The device's answer is no longer kept. Nothing was repeated.",
            },
          };
        if (row.state === "lost" && retriesAfterLoss(row.effect, row.attempt)) {
          const reopened = await reopenLostRead(
            ctx.db,
            row,
            new Date(commandDeadlineAt(row.kind, now())),
          );
          if (reopened) continue;
        }
        return closed(row, row.state as ClosureState);
      }
      if (ctx.signal.aborted) {
        await closeDeviceCommand(ctx.db, row, "cancelled");
        continue;
      }
      const verdict = livenessVerdict(
        {
          state: row.state,
          deadline_at_ms: row.deadline_at.getTime(),
          claimed_at_ms: row.claimed_at?.getTime() ?? null,
          last_progress_at_ms: row.last_progress_at?.getTime() ?? null,
          last_heartbeat_at_ms: watched.last_heartbeat_at?.getTime() ?? null,
        },
        now(),
      );
      if (verdict.kind === "expired") await closeDeviceCommand(ctx.db, row, "expired");
      else if (verdict.kind === "lost") await closeDeviceCommand(ctx.db, row, "lost");
      else if (verdict.kind === "wait") await waits.next(verdict.recheck_at_ms - now());
    }
  } finally {
    waits.close();
  }
}
