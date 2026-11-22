import type { WorkspaceLanguage } from "@shared/workspace-language.ts";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { createConnector } from "../connectors/service.ts";
import type { Executor } from "../db/client.ts";
import { connectors, deviceRunners } from "../db/schema/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { deviceConnectorSpecs, missingDeviceConnectors } from "./core/device-connectors.ts";

export async function ensureDeviceConnectors(
  db: Executor,
  device: { tenant_id: string; device_id: string },
  locale: WorkspaceLanguage,
): Promise<number> {
  const [runner] = await db
    .select({
      label: deviceRunners.device_label,
      owner: deviceRunners.owner_user_id,
      capabilities: deviceRunners.capabilities,
      revoked_at: deviceRunners.revoked_at,
    })
    .from(deviceRunners)
    .where(
      and(eq(deviceRunners.tenant_id, device.tenant_id), eq(deviceRunners.id, device.device_id)),
    )
    .limit(1);
  if (!runner || runner.revoked_at) return 0;
  const specs = deviceConnectorSpecs(
    { id: device.device_id, label: runner.label },
    runner.capabilities.capabilities,
    locale,
  );
  if (specs.length === 0) return 0;
  const existing = await db
    .select({ slug: connectors.slug, environment: connectors.environment })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, device.tenant_id),
        inArray(connectors.slug, [...new Set(specs.map((spec) => spec.slug))]),
        isNull(connectors.deleted_at),
      ),
    );
  const missing = missingDeviceConnectors(specs, existing);
  for (const spec of missing)
    await createConnector(
      {
        tenant_id: device.tenant_id,
        input: {
          name: spec.name,
          slug: spec.slug,
          driver: spec.driver,
          environment: spec.environment,
          auth_type: "none",
          config: spec.config,
        },
        actor_id: runner.owner,
        actor_type: "user",
      },
      db,
    );
  return missing.length;
}

export async function disableDeviceConnectors(
  tx: Executor,
  device: { tenant_id: string; device_id: string },
): Promise<number> {
  const rows = await tx
    .update(connectors)
    .set({ enabled: false, last_error: "device_revoked", updated_at: new Date() })
    .where(
      and(
        eq(connectors.tenant_id, device.tenant_id),
        like(connectors.slug, `device-${device.device_id}-%`),
        eq(connectors.enabled, true),
        isNull(connectors.deleted_at),
      ),
    )
    .returning({ id: connectors.id });
  for (const row of rows)
    await emitResourceChange(tx, {
      tenant_id: device.tenant_id,
      type: "connector.updated",
      ids: { connector_id: row.id },
    });
  return rows.length;
}
