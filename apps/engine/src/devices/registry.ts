import { createPublicKey } from "node:crypto";
import type { DeviceAllowance } from "@shared/device/boundary.ts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActionValue } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  cockpitInstallations,
  deviceAllowances,
  deviceRunners,
  users,
} from "../db/schema/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import type { RegisteredDevice } from "../workflows/core/device-approval.ts";
import { closeRevokedCommands } from "./channel.ts";
import { ALLOWANCE_AUDIT_ACTIONS, type AllowanceRow, diffAllowances } from "./core/allowances.ts";
import { DEVICE_ONLINE_WINDOW_MS } from "./core/offline-policy.ts";
import { disableDeviceConnectors } from "./device-connectors.ts";

export { DEVICE_ONLINE_WINDOW_MS };

export class DeviceRegistryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

function refuse(code: string, status: 400 | 403 | 404 | 409, message: string): never {
  throw new DeviceRegistryError(code, status, message);
}

export function normalizedRunnerKey(pem: string): string {
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(pem);
  } catch {
    refuse("public_key_invalid", 400, "the runner key is not a readable public key");
  }
  if (key.asymmetricKeyType !== "ed25519")
    refuse("public_key_invalid", 400, "the runner key must be an Ed25519 public key");
  return key.export({ type: "spki", format: "pem" }).toString();
}

interface Actor {
  tenant_id: string;
  user_id: string;
}

async function revokeRunnerRows(
  tx: Executor,
  rows: { id: string; device_label: string; installation_id: string }[],
  tenant_id: string,
  actor: { actor_type: "user" | "system"; actor_id: string | null },
  reason: string,
): Promise<void> {
  for (const row of rows) {
    await auditAwait(
      {
        tenant_id,
        ...actor,
        action: AuditAction.DEVICE_RUNNER_REVOKED,
        resource_type: "device_runner",
        resource_id: row.id,
        result: "success",
        reason,
        metadata: {
          device_id: row.id,
          device_label: row.device_label,
          installation_id: row.installation_id,
          reason,
        },
      },
      tx,
    );
    await closeRevokedCommands(tx, { tenant_id, device_id: row.id });
    await disableDeviceConnectors(tx, { tenant_id, device_id: row.id });
    await emitResourceChange(tx, {
      tenant_id,
      type: "device.offline",
      ids: { device_id: row.id },
    });
  }
}

export async function revokeDeviceRunnersForInstallation(
  tx: Executor,
  input: { tenant_id: string; installation_id: string; actor_id: string | null; reason: string },
): Promise<number> {
  const rows = await tx
    .update(deviceRunners)
    .set({
      revoked_at: sql`clock_timestamp()`,
      revoked_reason: input.reason,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(deviceRunners.tenant_id, input.tenant_id),
        eq(deviceRunners.installation_id, input.installation_id),
        isNull(deviceRunners.revoked_at),
      ),
    )
    .returning({
      id: deviceRunners.id,
      device_label: deviceRunners.device_label,
      installation_id: deviceRunners.installation_id,
    });
  await revokeRunnerRows(
    tx,
    rows,
    input.tenant_id,
    { actor_type: input.actor_id ? "user" : "system", actor_id: input.actor_id },
    input.reason,
  );
  return rows.length;
}

export async function enrollDeviceRunner(
  db: Db,
  actor: Actor & { installation_id: string | null },
  input: { public_key: string; runner_version?: string | undefined },
): Promise<{ device_runner_id: string; device_label: string }> {
  if (!actor.installation_id)
    refuse(
      "desktop_session_required",
      403,
      "enroll the runner from the desktop app's own session on this device",
    );
  const installation_id = actor.installation_id;
  const public_key = normalizedRunnerKey(input.public_key);
  return db.transaction(async (tx) => {
    const [installation] = await tx
      .select({
        kind: cockpitInstallations.kind,
        device_label: cockpitInstallations.device_label,
        owner_user_id: cockpitInstallations.owner_user_id,
      })
      .from(cockpitInstallations)
      .where(
        and(
          eq(cockpitInstallations.tenant_id, actor.tenant_id),
          eq(cockpitInstallations.id, installation_id),
          isNull(cockpitInstallations.revoked_at),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !installation ||
      installation.kind !== "desktop" ||
      installation.owner_user_id !== actor.user_id ||
      !installation.device_label
    )
      refuse(
        "desktop_session_required",
        403,
        "only a signed-in desktop device can enroll a runner",
      );
    await revokeDeviceRunnersForInstallation(tx, {
      tenant_id: actor.tenant_id,
      installation_id,
      actor_id: actor.user_id,
      reason: "re_enrolled",
    });
    const [runner] = await tx
      .insert(deviceRunners)
      .values({
        tenant_id: actor.tenant_id,
        installation_id,
        owner_user_id: actor.user_id,
        device_label: installation.device_label,
        public_key,
        ...(input.runner_version ? { app_version: input.runner_version } : {}),
      })
      .returning({ id: deviceRunners.id, device_label: deviceRunners.device_label });
    if (!runner) throw new Error("device runner insert returned no row");
    await auditAwait(
      {
        tenant_id: actor.tenant_id,
        actor_type: "user",
        actor_id: actor.user_id,
        action: AuditAction.DEVICE_RUNNER_ENROLLED,
        resource_type: "device_runner",
        resource_id: runner.id,
        result: "success",
        metadata: {
          device_id: runner.id,
          device_label: runner.device_label,
          installation_id,
          ...(input.runner_version ? { runner_version: input.runner_version } : {}),
        },
      },
      tx,
    );
    return { device_runner_id: runner.id, device_label: runner.device_label };
  });
}

export async function revokeDevice(
  db: Db,
  actor: Actor & { may_revoke_any: boolean },
  device_id: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ownerCond = actor.may_revoke_any ? [] : [eq(deviceRunners.owner_user_id, actor.user_id)];
    const rows = await tx
      .update(deviceRunners)
      .set({
        revoked_at: sql`clock_timestamp()`,
        revoked_reason: "revoked",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(deviceRunners.tenant_id, actor.tenant_id),
          eq(deviceRunners.id, device_id),
          isNull(deviceRunners.revoked_at),
          ...ownerCond,
        ),
      )
      .returning({
        id: deviceRunners.id,
        device_label: deviceRunners.device_label,
        installation_id: deviceRunners.installation_id,
      });
    await revokeRunnerRows(
      tx,
      rows,
      actor.tenant_id,
      { actor_type: "user", actor_id: actor.user_id },
      "revoked",
    );
    return rows.length > 0;
  });
}

export interface DeviceListing {
  id: string;
  device_label: string;
  owner_user_id: string;
  installation_id: string;
  enrolled_at: Date;
  last_heartbeat_at: Date | null;
  online: boolean;
  capabilities: Record<string, unknown>;
  app_version: string | null;
  allowance_counts: { folder: number; site: number; app: number; keep_out: number };
}

export async function listDevices(
  db: Executor,
  tenant_id: string,
  owner_user_id: string | null,
): Promise<DeviceListing[]> {
  const ownerCond = owner_user_id ? [eq(deviceRunners.owner_user_id, owner_user_id)] : [];
  const rows = await db
    .select({
      id: deviceRunners.id,
      device_label: deviceRunners.device_label,
      owner_user_id: deviceRunners.owner_user_id,
      installation_id: deviceRunners.installation_id,
      enrolled_at: deviceRunners.enrolled_at,
      last_heartbeat_at: deviceRunners.last_heartbeat_at,
      online: sql<boolean>`coalesce(${deviceRunners.last_heartbeat_at} > clock_timestamp() - (${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond'), false)`,
      capabilities: deviceRunners.capabilities,
      app_version: deviceRunners.app_version,
    })
    .from(deviceRunners)
    .where(
      and(eq(deviceRunners.tenant_id, tenant_id), isNull(deviceRunners.revoked_at), ...ownerCond),
    )
    .orderBy(asc(deviceRunners.enrolled_at), asc(deviceRunners.id));
  const counts = rows.length
    ? await db
        .select({
          device_runner_id: deviceAllowances.device_runner_id,
          kind: deviceAllowances.kind,
          count: sql<number>`count(*)::int`,
        })
        .from(deviceAllowances)
        .where(and(eq(deviceAllowances.tenant_id, tenant_id), isNull(deviceAllowances.removed_at)))
        .groupBy(deviceAllowances.device_runner_id, deviceAllowances.kind)
    : [];
  return rows.map((row) => {
    const allowance_counts = { folder: 0, site: 0, app: 0, keep_out: 0 };
    for (const count of counts)
      if (count.device_runner_id === row.id) allowance_counts[count.kind] = Number(count.count);
    return { ...row, online: Boolean(row.online), allowance_counts };
  });
}

const ALLOWANCE_COLUMNS = {
  id: deviceAllowances.id,
  kind: deviceAllowances.kind,
  item_id: deviceAllowances.item_id,
  display: deviceAllowances.display,
  digest: deviceAllowances.digest,
  access: deviceAllowances.access,
  private: deviceAllowances.private,
  keep_out_target: deviceAllowances.keep_out_target,
  entered_by: deviceAllowances.entered_by,
};

export async function activeAllowances(
  db: Executor,
  tenant_id: string,
  device_id: string,
): Promise<(AllowanceRow & { id: string })[]> {
  return db
    .select(ALLOWANCE_COLUMNS)
    .from(deviceAllowances)
    .where(
      and(
        eq(deviceAllowances.tenant_id, tenant_id),
        eq(deviceAllowances.device_runner_id, device_id),
        isNull(deviceAllowances.removed_at),
      ),
    )
    .orderBy(asc(deviceAllowances.kind), asc(deviceAllowances.item_id));
}

export async function mirrorDeviceAllowances(
  db: Db,
  actor: Actor & { installation_id: string | null },
  device_id: string,
  next: readonly DeviceAllowance[],
): Promise<{ added: number; removed: number }> {
  return db.transaction(async (tx) => {
    const [runner] = await tx
      .select({
        installation_id: deviceRunners.installation_id,
        owner_user_id: deviceRunners.owner_user_id,
        device_label: deviceRunners.device_label,
      })
      .from(deviceRunners)
      .where(
        and(
          eq(deviceRunners.tenant_id, actor.tenant_id),
          eq(deviceRunners.id, device_id),
          isNull(deviceRunners.revoked_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!runner || runner.owner_user_id !== actor.user_id)
      refuse("device_not_found", 404, "device not found");
    if (runner.installation_id !== actor.installation_id)
      refuse(
        "device_session_required",
        403,
        "allowances are changed only in SubKit on that device",
      );
    const current = await activeAllowances(tx, actor.tenant_id, device_id);
    const diff = diffAllowances(current, next);
    if (!diff.ok)
      refuse(
        diff.code,
        400,
        diff.code === "private_site_needs_person"
          ? "a private address counts only when the person entered it on the device"
          : "every allowance may appear once, and at most 500 in total",
      );
    const removedIds = current
      .filter((row) =>
        diff.removed.some((gone) => gone.kind === row.kind && gone.item_id === row.item_id),
      )
      .map((row) => row.id);
    for (const id of removedIds)
      await tx
        .update(deviceAllowances)
        .set({ removed_at: sql`clock_timestamp()` })
        .where(and(eq(deviceAllowances.tenant_id, actor.tenant_id), eq(deviceAllowances.id, id)));
    if (diff.added.length > 0)
      await tx.insert(deviceAllowances).values(
        diff.added.map((row) => ({
          ...row,
          tenant_id: actor.tenant_id,
          device_runner_id: device_id,
        })),
      );
    const changes: Array<[AuditActionValue, AllowanceRow]> = [
      ...diff.removed.map(
        (row) =>
          [ALLOWANCE_AUDIT_ACTIONS.removed[row.kind], row] as [AuditActionValue, AllowanceRow],
      ),
      ...diff.added.map(
        (row) => [ALLOWANCE_AUDIT_ACTIONS.added[row.kind], row] as [AuditActionValue, AllowanceRow],
      ),
    ];
    for (const [action, row] of changes)
      await auditAwait(
        {
          tenant_id: actor.tenant_id,
          actor_type: "user",
          actor_id: actor.user_id,
          action,
          resource_type: "device_runner",
          resource_id: device_id,
          result: "success",
          metadata: {
            device_id,
            device_label: runner.device_label,
            kind: row.kind,
            item_id: row.item_id,
            entered_by: row.entered_by,
            ...(row.digest ? { digest: row.digest } : {}),
            ...(row.access ? { access: row.access } : {}),
            ...(row.private !== null ? { private: row.private } : {}),
          },
        },
        tx,
      );
    return { added: diff.added.length, removed: diff.removed.length };
  });
}

export async function registeredDeviceFor(
  db: Executor,
  tenant_id: string,
  device_id: string,
): Promise<RegisteredDevice | null> {
  const [row] = await db
    .select({
      installation_id: deviceRunners.installation_id,
      runner_revoked: deviceRunners.revoked_at,
      installation_revoked: cockpitInstallations.revoked_at,
      owner_status: users.status,
      owner_deleted: users.deleted_at,
    })
    .from(deviceRunners)
    .innerJoin(
      cockpitInstallations,
      and(
        eq(cockpitInstallations.tenant_id, deviceRunners.tenant_id),
        eq(cockpitInstallations.id, deviceRunners.installation_id),
      ),
    )
    .innerJoin(
      users,
      and(eq(users.tenant_id, deviceRunners.tenant_id), eq(users.id, deviceRunners.owner_user_id)),
    )
    .where(and(eq(deviceRunners.tenant_id, tenant_id), eq(deviceRunners.id, device_id)))
    .limit(1);
  if (!row) return null;
  return {
    installation_id: row.installation_id,
    revoked:
      row.runner_revoked !== null ||
      row.installation_revoked !== null ||
      row.owner_status !== "active" ||
      row.owner_deleted !== null,
  };
}
