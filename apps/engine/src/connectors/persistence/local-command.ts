import { and, eq, isNull } from "drizzle-orm";
import { connectorMcpSessions, connectors, type Executor } from "../../db/index.ts";

export type LocalCommandConnectorRow = typeof connectors.$inferSelect;

export async function readMcpConnectorConfig(
  db: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<{ config: unknown } | null> {
  const [row] = await db
    .select({ config: connectors.config })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, connector_id),
        eq(connectors.driver, "mcp"),
        isNull(connectors.deleted_at),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function lockLiveConnector(
  tx: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<LocalCommandConnectorRow | null> {
  const [row] = await tx
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, connector_id),
        isNull(connectors.deleted_at),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

export async function storeLocalCommandConfirmation(
  tx: Executor,
  tenant_id: string,
  connector_id: string,
  config: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(connectors)
    .set({ config, updated_at: new Date() })
    .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector_id)));
  await tx
    .update(connectorMcpSessions)
    .set({ consecutive_failures: 0, backoff_until: null, updated_at: new Date() })
    .where(
      and(
        eq(connectorMcpSessions.tenant_id, tenant_id),
        eq(connectorMcpSessions.connector_id, connector_id),
      ),
    );
}
