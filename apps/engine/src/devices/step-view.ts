import { capabilityOfKind } from "@shared/device/protocol.ts";
import { and, asc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { deviceEffectAuditMetadata } from "../audit/device-metadata.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { deviceCommands, deviceRunners } from "../db/schema/index.ts";
import { findVisibleExecutionRow } from "../execution/read-service.ts";
import { commandForRunner, storedResult } from "./channel.ts";
import {
  type DeviceStepViewState,
  hasScreenshot,
  screenshotPng,
  stepTargets,
  stepViewState,
} from "./core/step-view.ts";

export interface DeviceStepView {
  command_id: string;
  step_id: string;
  kind: string;
  state: DeviceStepViewState;
  target: string | null;
  screenshot: boolean;
}

function commandsOf(db: Db, tenant_id: string, execution_id: string) {
  return db
    .select({ command: deviceCommands, owner_user_id: deviceRunners.owner_user_id })
    .from(deviceCommands)
    .innerJoin(
      deviceRunners,
      and(
        eq(deviceRunners.tenant_id, deviceCommands.tenant_id),
        eq(deviceRunners.id, deviceCommands.device_id),
      ),
    )
    .where(
      and(eq(deviceCommands.tenant_id, tenant_id), eq(deviceCommands.execution_id, execution_id)),
    )
    .orderBy(asc(deviceCommands.created_at), asc(deviceCommands.id))
    .limit(500);
}

function personInPerson(principal: ResolvedPrincipal): boolean {
  return (
    principal.kind === "user" &&
    principal.api_key_id === undefined &&
    principal.via === undefined &&
    (principal.credential_origin ?? null) === null
  );
}

export async function listExecutionDeviceSteps(
  db: Db,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<DeviceStepView[] | null> {
  if (!(await findVisibleExecutionRow(db, principal, execution_id))) return null;
  const rows = await commandsOf(db, principal.tenant_id, execution_id);
  const targets = stepTargets(
    rows.map(({ command }) => ({ kind: command.kind, args: commandForRunner(command).args })),
  );
  return rows.map(({ command, owner_user_id }, index) => {
    const owner = principal.kind === "user" && owner_user_id === principal.id;
    const viewer = owner && personInPerson(principal);
    return {
      command_id: command.id,
      step_id: command.step_id,
      kind: command.kind,
      state: stepViewState(command.state, command.effect),
      target: owner ? (targets[index] ?? "") : null,
      screenshot: viewer && hasScreenshot(command.kind, command.state, command.result !== null),
    };
  });
}

export async function readStepScreenshot(
  db: Db,
  principal: ResolvedPrincipal,
  execution_id: string,
  command_id: string,
): Promise<Buffer | null> {
  if (!personInPerson(principal)) return null;
  if (!(await findVisibleExecutionRow(db, principal, execution_id))) return null;
  const [row] = await db
    .select({ command: deviceCommands, label: deviceRunners.device_label })
    .from(deviceCommands)
    .innerJoin(
      deviceRunners,
      and(
        eq(deviceRunners.tenant_id, deviceCommands.tenant_id),
        eq(deviceRunners.id, deviceCommands.device_id),
        eq(deviceRunners.owner_user_id, principal.id),
      ),
    )
    .where(
      and(
        eq(deviceCommands.tenant_id, principal.tenant_id),
        eq(deviceCommands.execution_id, execution_id),
        eq(deviceCommands.id, command_id),
      ),
    )
    .limit(1);
  if (!row || !hasScreenshot(row.command.kind, row.command.state, row.command.result !== null))
    return null;
  const png = screenshotPng(storedResult(row.command));
  if (!png) return null;
  await auditAwait(
    {
      tenant_id: principal.tenant_id,
      actor_type: "user",
      actor_id: principal.id,
      action: AuditAction.DEVICE_SCREENSHOT_VIEWED,
      resource_type: "device_command",
      resource_id: row.command.id,
      result: "success",
      metadata: deviceEffectAuditMetadata(
        {
          device_id: row.command.device_id,
          device_label: row.label,
          capability: capabilityOfKind(row.command.kind),
          command_id: row.command.id,
          generation: row.command.generation,
          execution_id,
        },
        "standard",
      ),
    },
    db,
  );
  return png;
}
