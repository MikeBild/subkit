import type { DeviceStopReport, Heartbeat } from "@shared/device/protocol.ts";
import type { WorkspaceLanguage } from "@shared/workspace-language.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { deviceRunners } from "../db/schema/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { closeStoppedCommands } from "./channel.ts";
import { mergedStopGeneration, stopReportIsNew } from "./core/generation.ts";
import { ensureDeviceConnectors } from "./device-connectors.ts";
import { DEVICE_ONLINE_WINDOW_MS } from "./registry.ts";
import type { RunnerIdentity } from "./runner-auth.ts";

const COMMAND_ID = /^[0-9a-f]{64}$/;

function runnerWhere(runner: RunnerIdentity) {
  return and(
    eq(deviceRunners.tenant_id, runner.tenant_id),
    eq(deviceRunners.id, runner.device_id),
    eq(deviceRunners.installation_id, runner.installation_id),
    isNull(deviceRunners.revoked_at),
  );
}

export async function recordHeartbeat(
  db: Db,
  runner: RunnerIdentity,
  heartbeat: Heartbeat,
  connectorLanguage: () => Promise<WorkspaceLanguage>,
): Promise<{ stop_generation: number } | null> {
  const recorded = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        stop_generation: deviceRunners.stop_generation,
        capabilities: deviceRunners.capabilities,
        was_online: sql<boolean>`coalesce(${deviceRunners.last_heartbeat_at} > clock_timestamp() - (${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond'), false)`,
      })
      .from(deviceRunners)
      .where(runnerWhere(runner))
      .for("update")
      .limit(1);
    if (!before) return null;
    const stop_generation = mergedStopGeneration(before.stop_generation, heartbeat.generation);
    await tx
      .update(deviceRunners)
      .set({
        last_heartbeat_at: sql`clock_timestamp()`,
        app_version: heartbeat.runner_version,
        capabilities: {
          os: heartbeat.os,
          capabilities: heartbeat.capabilities,
          personal: heartbeat.personal,
          permissions: heartbeat.permissions,
          allowances_digest: heartbeat.allowances_digest,
        },
        stop_generation,
        updated_at: new Date(),
      })
      .where(runnerWhere(runner));
    if (stop_generation > before.stop_generation)
      await closeStoppedCommands(tx, runner, stop_generation);
    if (!before.was_online)
      await emitResourceChange(tx, {
        tenant_id: runner.tenant_id,
        type: "device.online",
        ids: { device_id: runner.device_id },
      });
    const changed =
      JSON.stringify(before.capabilities.capabilities ?? []) !==
      JSON.stringify(heartbeat.capabilities);
    return { stop_generation, connectors: changed || !before.was_online };
  });
  if (!recorded) return null;
  if (recorded.connectors)
    await ensureDeviceConnectors(
      db,
      { tenant_id: runner.tenant_id, device_id: runner.device_id },
      await connectorLanguage(),
    );
  return { stop_generation: recorded.stop_generation };
}

export async function recordStop(
  db: Db,
  runner: RunnerIdentity,
  report: DeviceStopReport,
): Promise<{ stop_generation: number; recorded: boolean } | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        stop_generation: deviceRunners.stop_generation,
        reported_stop_generation: deviceRunners.reported_stop_generation,
      })
      .from(deviceRunners)
      .where(runnerWhere(runner))
      .for("update")
      .limit(1);
    if (!before) return null;
    const stop_generation = mergedStopGeneration(before.stop_generation, report.generation);
    const recorded = stopReportIsNew(before.reported_stop_generation, report.generation);
    if (!recorded) return { stop_generation, recorded };
    await closeStoppedCommands(tx, runner, stop_generation);
    await tx
      .update(deviceRunners)
      .set({ stop_generation, reported_stop_generation: report.generation, updated_at: new Date() })
      .where(runnerWhere(runner));
    const command_id =
      report.command_id && COMMAND_ID.test(report.command_id) ? report.command_id : undefined;
    await auditAwait(
      {
        tenant_id: runner.tenant_id,
        actor_type: "user",
        actor_id: runner.owner_user_id,
        action: AuditAction.DEVICE_STOP,
        resource_type: "device_runner",
        resource_id: runner.device_id,
        result: "success",
        metadata: {
          device_id: runner.device_id,
          device_label: runner.device_label,
          generation: report.generation,
          stopped_at: report.stopped_at,
          ...(command_id ? { command_id } : {}),
        },
      },
      tx,
    );
    await emitResourceChange(tx, {
      tenant_id: runner.tenant_id,
      type: "device.command",
      ids: { device_id: runner.device_id, command_id: command_id ?? null },
    });
    return { stop_generation, recorded };
  });
}
