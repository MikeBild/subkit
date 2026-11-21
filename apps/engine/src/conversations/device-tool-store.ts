import { DEVICE_CAPABILITIES, type DeviceCapability } from "@shared/device/protocol.ts";
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { conversationToolCalls, deviceRunners } from "../db/schema/index.ts";
import { DEVICE_ONLINE_WINDOW_MS } from "../devices/core/offline-policy.ts";
import type { LocalRunSource } from "../devices/core/run-source.ts";
import { DEVICE_TOOL_SPECS } from "./core/device-tools/catalog.ts";
import type { DeviceStepRecord } from "./core/device-tools/history.ts";
import type { DeviceFacts } from "./core/device-tools/palette.ts";
import type { ElementFacts } from "./core/device-tools/snapshot.ts";

export type { DeviceStepRecord };

import type { FilledValue } from "./core/device-tools/step.ts";

export interface PendingDeviceCommand {
  readonly tool: string;
  readonly device_id: string;
  readonly command_id: string;
  readonly kind: string;
  readonly args: Record<string, unknown>;
  readonly owner: { readonly kind: "task_run" | "conversation"; readonly id: string };
  readonly source: LocalRunSource;
  readonly ref: string | null;
  readonly element: ElementFacts | null;
  readonly partition: string | null;
  readonly filled: readonly FilledValue[];
}

function isCapability(value: unknown): value is DeviceCapability {
  return typeof value === "string" && (DEVICE_CAPABILITIES as readonly string[]).includes(value);
}

export async function loadPersonDevices(
  db: Executor,
  tenant_id: string,
  owner_user_id: string,
): Promise<DeviceFacts[]> {
  const rows = await db
    .select({
      device_id: deviceRunners.id,
      owner_user_id: deviceRunners.owner_user_id,
      label: deviceRunners.device_label,
      capabilities: deviceRunners.capabilities,
      online: sql<boolean>`coalesce(${deviceRunners.last_heartbeat_at} > clock_timestamp() - (${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond'), false)`,
    })
    .from(deviceRunners)
    .where(
      and(
        eq(deviceRunners.tenant_id, tenant_id),
        eq(deviceRunners.owner_user_id, owner_user_id),
        isNull(deviceRunners.revoked_at),
      ),
    );
  return rows.map((row) => {
    const personal = (row.capabilities as { personal?: unknown }).personal;
    return {
      device_id: row.device_id,
      owner_user_id: row.owner_user_id,
      label: row.label,
      online: row.online === true,
      personal: Array.isArray(personal) ? personal.filter(isCapability) : [],
    };
  });
}

function namesOf(capability: DeviceCapability): string[] {
  return DEVICE_TOOL_SPECS.filter((tool) => tool.capability === capability).map(
    (tool) => tool.name,
  );
}

export async function loadDeviceSteps(
  db: Executor,
  p: {
    readonly tenant_id: string;
    readonly conversation_id: string;
    readonly capability: DeviceCapability;
    readonly since: Date;
    readonly except_call: string | null;
  },
): Promise<DeviceStepRecord[]> {
  const rows = await db
    .select({
      step: sql<unknown>`${conversationToolCalls.confirmation_data} -> 'device_step'`,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, p.tenant_id),
        eq(conversationToolCalls.conversation_id, p.conversation_id),
        inArray(conversationToolCalls.tool, namesOf(p.capability)),
        gte(conversationToolCalls.created_at, p.since),
        sql`${conversationToolCalls.confirmation_data} ? 'device_step'`,
        ...(p.except_call ? [ne(conversationToolCalls.id, p.except_call)] : []),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(200);
  return rows.flatMap((row) =>
    row.step !== null && typeof row.step === "object" ? [row.step as DeviceStepRecord] : [],
  );
}

async function mergeData(
  db: Executor,
  tenant_id: string,
  tool_call_id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db
    .update(conversationToolCalls)
    .set({
      confirmation_data: sql`COALESCE(${conversationToolCalls.confirmation_data}, '{}'::jsonb) || ${JSON.stringify(data)}::jsonb`,
    })
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.id, tool_call_id),
      ),
    );
}

export async function recordDeviceStep(
  db: Executor,
  tenant_id: string,
  tool_call_id: string,
  step: DeviceStepRecord,
): Promise<void> {
  await mergeData(db, tenant_id, tool_call_id, { device_step: step });
}

export async function recordPendingCommand(
  db: Executor,
  tenant_id: string,
  tool_call_id: string,
  pending: PendingDeviceCommand,
): Promise<void> {
  await mergeData(db, tenant_id, tool_call_id, { device_pending: pending });
}

export async function loadPendingCommand(
  db: Executor,
  tenant_id: string,
  tool_call_id: string,
): Promise<{ conversation_id: string; pending: PendingDeviceCommand } | null> {
  const [row] = await db
    .select({
      conversation_id: conversationToolCalls.conversation_id,
      pending: sql<unknown>`${conversationToolCalls.confirmation_data} -> 'device_pending'`,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.id, tool_call_id),
      ),
    )
    .limit(1);
  if (!row || row.pending === null || typeof row.pending !== "object") return null;
  return { conversation_id: row.conversation_id, pending: row.pending as PendingDeviceCommand };
}
