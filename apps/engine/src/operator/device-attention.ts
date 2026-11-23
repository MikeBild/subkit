import { and, eq, gt, inArray, isNotNull, isNull, lte, min, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { deviceCommands, deviceRunners, deviceWaits, executions } from "../db/schema/index.ts";
import {
  DEVICE_ONLINE_WINDOW_MS,
  WAIT_ATTENTION_AFTER_MS,
} from "../devices/core/offline-policy.ts";
import { type ComputerPermission, missingPermissions } from "../devices/core/permission-gap.ts";
import { hasBuiltinAdminRole } from "../rbac/index.ts";
import type { TenantFacts } from "./attention-readers.ts";
import { type AttentionItem, compareAttentionItems } from "./core/attention.ts";
import {
  HANDOVER_COMMAND_KINDS,
  handoverAttentionItem,
  projectHandovers,
  type WaitingHandover,
} from "./core/device-handover.ts";
import { cockpitRunsHref } from "./operating-figures.ts";

export interface WaitingDevice {
  device_id: string;
  device_label: string;
  owner_user_id: string;
  runs: number;
  since: Date;
  cap_at: Date;
}

export function deviceWaitAttentionItem(device: WaitingDevice): AttentionItem {
  return {
    id: `device_wait:${device.device_id}`,
    class: "stopped",
    severity: "urgent",
    kind: "device_offline_waiting",
    subject: { kind: "device", id: device.device_id, name: device.device_label },
    reason: "device_offline_waiting",
    trigger: null,
    cause_class: null,
    counts: {},
    since: device.since.toISOString(),
    deadline: device.cap_at.toISOString(),
    detail: `${device.runs} ${device.runs === 1 ? "run waits" : "runs wait"} for this device`,
    actions: [
      {
        verb: "open_runs",
        href: cockpitRunsHref({ status: "waiting_for_device", device: device.device_id }),
        primary: true,
        permission: "device:read",
      },
    ],
  };
}

export async function waitingDevices(
  db: Db,
  tenant_id: string,
  now: Date,
): Promise<WaitingDevice[]> {
  const rows = await db
    .select({
      device_id: deviceWaits.device_id,
      device_label: deviceRunners.device_label,
      owner_user_id: deviceRunners.owner_user_id,
      runs: sql<number>`count(*)::int`,
      since: min(deviceWaits.waiting_since),
      cap_at: min(deviceWaits.cap_at),
    })
    .from(deviceWaits)
    .innerJoin(
      executions,
      and(
        eq(executions.tenant_id, deviceWaits.tenant_id),
        eq(executions.id, deviceWaits.execution_id),
        eq(executions.status, "waiting_for_device"),
      ),
    )
    .innerJoin(
      deviceRunners,
      and(
        eq(deviceRunners.tenant_id, deviceWaits.tenant_id),
        eq(deviceRunners.id, deviceWaits.device_id),
      ),
    )
    .where(
      and(
        eq(deviceWaits.tenant_id, tenant_id),
        lte(deviceWaits.waiting_since, new Date(now.getTime() - WAIT_ATTENTION_AFTER_MS)),
      ),
    )
    .groupBy(deviceWaits.device_id, deviceRunners.device_label, deviceRunners.owner_user_id)
    .limit(100);
  return rows.flatMap((row) =>
    row.since && row.cap_at ? [{ ...row, since: row.since, cap_at: row.cap_at }] : [],
  );
}

export interface PermissionGap {
  device_id: string;
  device_label: string;
  owner_user_id: string;
  missing: ComputerPermission[];
  since: Date;
}

export function permissionGapAttentionItem(gap: PermissionGap): AttentionItem {
  return {
    id: `device_permission:${gap.device_id}`,
    class: "stopped",
    severity: "urgent",
    kind: "device_permission_missing",
    subject: { kind: "device", id: gap.device_id, name: gap.device_label },
    reason: "device_permission_missing",
    trigger: null,
    cause_class: null,
    counts: {},
    since: gap.since.toISOString(),
    deadline: null,
    detail: `Computer use on this Mac lacks: ${gap.missing.join(", ")}`,
    actions: [
      {
        verb: "open",
        href: "/cockpit/settings?area=devices",
        primary: true,
        permission: "device:read",
      },
    ],
  };
}

export async function permissionGaps(db: Db, tenant_id: string): Promise<PermissionGap[]> {
  const rows = await db
    .select({
      device_id: deviceRunners.id,
      device_label: deviceRunners.device_label,
      owner_user_id: deviceRunners.owner_user_id,
      capabilities: deviceRunners.capabilities,
      since: deviceRunners.last_heartbeat_at,
    })
    .from(deviceRunners)
    .where(
      and(
        eq(deviceRunners.tenant_id, tenant_id),
        isNull(deviceRunners.revoked_at),
        sql`${deviceRunners.last_heartbeat_at} > clock_timestamp() - (${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond')`,
        sql`${deviceRunners.capabilities}->'capabilities' ? 'computer'`,
      ),
    )
    .limit(100);
  return rows.flatMap((row) => {
    const missing = missingPermissions(row.capabilities);
    return missing.length > 0 && row.since
      ? [
          {
            device_id: row.device_id,
            device_label: row.device_label,
            owner_user_id: row.owner_user_id,
            missing,
            since: row.since,
          },
        ]
      : [];
  });
}

export async function waitingHandovers(
  db: Db,
  tenant_id: string,
  now: Date,
): Promise<WaitingHandover[]> {
  const rows = await db
    .select({
      device_id: deviceCommands.device_id,
      device_label: deviceRunners.device_label,
      owner_user_id: deviceRunners.owner_user_id,
      claimed_at: deviceCommands.claimed_at,
      deadline_at: deviceCommands.deadline_at,
      execution_id: deviceCommands.execution_id,
      conversation_id: deviceCommands.conversation_id,
    })
    .from(deviceCommands)
    .innerJoin(
      deviceRunners,
      and(
        eq(deviceRunners.tenant_id, deviceCommands.tenant_id),
        eq(deviceRunners.id, deviceCommands.device_id),
      ),
    )
    .where(
      and(
        eq(deviceCommands.tenant_id, tenant_id),
        eq(deviceCommands.state, "claimed"),
        inArray(deviceCommands.kind, [...HANDOVER_COMMAND_KINDS]),
        isNotNull(deviceCommands.claimed_at),
        gt(deviceCommands.deadline_at, now),
        isNull(deviceRunners.revoked_at),
      ),
    )
    .limit(100);
  return projectHandovers(
    rows.flatMap((row) => (row.claimed_at ? [{ ...row, claimed_at: row.claimed_at }] : [])),
  );
}

export async function withDeviceFacts(
  db: Db,
  tenantId: string,
  facts: TenantFacts,
  now: Date,
): Promise<TenantFacts> {
  const [device_waits, device_permissions, device_handovers] = await Promise.all([
    waitingDevices(db, tenantId, now).catch(() => facts.device_waits ?? []),
    permissionGaps(db, tenantId).catch(() => facts.device_permissions ?? []),
    waitingHandovers(db, tenantId, now).catch(() => facts.device_handovers ?? []),
  ]);
  return { ...facts, device_waits, device_permissions, device_handovers };
}

export function withDeviceAttention(
  principal: ResolvedPrincipal,
  items: readonly AttentionItem[],
  facts: Pick<TenantFacts, "device_waits" | "device_permissions" | "device_handovers">,
): AttentionItem[] {
  if (principal.kind !== "user") return [...items];
  const admin = hasBuiltinAdminRole(principal);
  const waits = (facts.device_waits ?? [])
    .filter((device) => admin || device.owner_user_id === principal.id)
    .map(deviceWaitAttentionItem);
  const gaps = (facts.device_permissions ?? [])
    .filter((gap) => gap.owner_user_id === principal.id)
    .map(permissionGapAttentionItem);
  const handovers = (facts.device_handovers ?? [])
    .filter((handover) => handover.owner_user_id === principal.id)
    .map(handoverAttentionItem);
  if (waits.length === 0 && gaps.length === 0 && handovers.length === 0) return [...items];
  return [...items, ...waits, ...gaps, ...handovers].sort(compareAttentionItems);
}
