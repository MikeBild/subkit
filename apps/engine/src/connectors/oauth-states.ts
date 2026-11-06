import { and, desc, eq, gt } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectorOauthStates, mcpOauthStates } from "../db/schema/index.ts";

type ConnectorOAuthStateRow = typeof connectorOauthStates.$inferSelect;
type McpOAuthStateRow = typeof mcpOauthStates.$inferSelect;
type NewMcpOAuthState = Omit<typeof mcpOauthStates.$inferInsert, "id" | "created_at">;

export async function claimConnectorOAuthState(
  db: Executor,
  state: string,
  at: Date,
): Promise<ConnectorOAuthStateRow | null> {
  // tenant-filter:exempt — unauthenticated OAuth callback; the single-use state token is the proof and yields the tenant
  const claimed = await db
    .delete(connectorOauthStates)
    .where(and(eq(connectorOauthStates.state, state), gt(connectorOauthStates.expires_at, at)))
    .returning();
  return claimed[0] ?? null;
}

export async function claimMcpOAuthState(
  db: Executor,
  state: string,
  at: Date,
): Promise<McpOAuthStateRow | null> {
  // tenant-filter:exempt — unauthenticated MCP OAuth callback; the single-use state token is the proof and yields the tenant
  const claimed = await db
    .delete(mcpOauthStates)
    .where(and(eq(mcpOauthStates.state, state), gt(mcpOauthStates.expires_at, at)))
    .returning();
  return claimed[0] ?? null;
}

export async function insertMcpOAuthState(db: Executor, values: NewMcpOAuthState): Promise<void> {
  await db.insert(mcpOauthStates).values(values);
}

export async function readMcpAuthorizationUrl(
  db: Executor,
  tenant_id: string,
  state: string,
): Promise<string | null> {
  const rows = await db
    .select({ authorization_url: mcpOauthStates.authorization_url })
    .from(mcpOauthStates)
    .where(and(eq(mcpOauthStates.tenant_id, tenant_id), eq(mcpOauthStates.state, state)))
    .limit(1);
  return rows[0]?.authorization_url ?? null;
}

export async function discardMcpOAuthState(
  db: Executor,
  tenant_id: string,
  state: string,
): Promise<void> {
  await db
    .delete(mcpOauthStates)
    .where(and(eq(mcpOauthStates.tenant_id, tenant_id), eq(mcpOauthStates.state, state)));
}

export async function hasPendingConnectorOAuthState(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: connectorOauthStates.id })
    .from(connectorOauthStates)
    .where(
      and(
        eq(connectorOauthStates.tenant_id, tenant_id),
        eq(connectorOauthStates.connector_id, connector_id),
        gt(connectorOauthStates.expires_at, now),
      ),
    )
    .orderBy(desc(connectorOauthStates.created_at))
    .limit(1);
  return rows.length > 0;
}

export async function insertConnectorOAuthState(
  db: Executor,
  values: typeof connectorOauthStates.$inferInsert,
): Promise<void> {
  await db.insert(connectorOauthStates).values(values);
}
