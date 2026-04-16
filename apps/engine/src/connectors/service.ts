// Connector CRUD. Tenant + environment scoped. The service is the only
// place that touches the `connectors` table — routes call through it so
// audit rows and slug normalization land consistently.

import { and, desc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, getDb } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import type {
  ConnectorView,
  CreateConnectorInput,
  DriverName,
  Environment,
  UpdateConnectorInput,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `cn-${Math.random().toString(36).slice(2, 8)}`
  );
}

function toView(row: typeof connectors.$inferSelect): ConnectorView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    driver: row.driver as DriverName,
    environment: row.environment as Environment,
    auth_type: row.auth_type as ConnectorView["auth_type"],
    base_url: row.base_url ?? null,
    dsn: row.dsn ?? null,
    config: (row.config as Record<string, unknown>) ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateConnectorParams {
  tenant_id: string;
  input: CreateConnectorInput;
  actor_id: string | null;
}

export async function createConnector(
  p: CreateConnectorParams,
  exec?: Executor,
): Promise<ConnectorView> {
  const db = exec ?? getDb();
  const slug = p.input.slug ?? slugify(p.input.name);
  const environment = p.input.environment ?? "dev";
  const auth_type = p.input.auth_type ?? "none";
  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(connectors)
      .values({
        tenant_id: p.tenant_id,
        slug,
        display_name: p.input.name,
        driver: p.input.driver,
        environment,
        auth_type,
        base_url: p.input.base_url ?? null,
        dsn: p.input.dsn ?? null,
        config: p.input.config ?? {},
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("connectors insert returned no row");
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONNECTOR_CREATED,
        resource_type: "connector",
        resource_id: row.id,
        result: "success",
        metadata: {
          slug,
          driver: p.input.driver,
          environment,
          auth_type,
        },
      },
      tx,
    );
    return toView(row);
  });
}

export async function listConnectors(
  tenant_id: string,
  opts: { environment?: Environment; limit?: number; offset?: number } = {},
  exec?: Executor,
): Promise<ConnectorView[]> {
  const db = exec ?? getDb();
  const conds = [eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)];
  if (opts.environment) conds.push(eq(connectors.environment, opts.environment));
  const rows = await db
    .select()
    .from(connectors)
    .where(and(...conds))
    .orderBy(desc(connectors.created_at))
    .limit(Math.min(opts.limit ?? 100, 500))
    .offset(opts.offset ?? 0);
  return rows.map(toView);
}

export async function getConnector(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<ConnectorView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, id),
        isNull(connectors.deleted_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? toView(row) : null;
}

/**
 * Resolve a connector for a target execution environment. The workflow
 * DAG pins a specific connector row by id (usually the `dev` row). When
 * an execution runs under a different `execution_mode`, we look up a
 * sibling row with the same tenant + slug + target environment and use
 * that instead. Falls back to the original row when no sibling exists.
 */
export async function getConnectorForEnvironment(
  tenant_id: string,
  id: string,
  environment: Environment,
  exec?: Executor,
): Promise<ConnectorView | null> {
  const db = exec ?? getDb();
  const base = await getConnector(tenant_id, id, db);
  if (!base) return null;
  if (base.environment === environment) return base;
  const rows = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.slug, base.slug),
        eq(connectors.environment, environment),
        isNull(connectors.deleted_at),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? toView(row) : base;
}

export async function updateConnector(
  tenant_id: string,
  id: string,
  patch: UpdateConnectorInput,
  actor_id: string | null,
  exec?: Executor,
): Promise<ConnectorView | null> {
  const db = exec ?? getDb();
  const updated = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, tenant_id),
          eq(connectors.id, id),
          isNull(connectors.deleted_at),
        ),
      )
      .limit(1);
    const prior = existing[0];
    if (!prior) return null;
    const set: Partial<typeof connectors.$inferInsert> = { updated_at: new Date() };
    if (patch.name !== undefined) set.display_name = patch.name;
    if (patch.base_url !== undefined) set.base_url = patch.base_url;
    if (patch.dsn !== undefined) set.dsn = patch.dsn;
    if (patch.auth_type !== undefined) set.auth_type = patch.auth_type;
    if (patch.config !== undefined) set.config = patch.config;
    const [row] = await tx.update(connectors).set(set).where(eq(connectors.id, id)).returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.CONNECTOR_UPDATED,
        resource_type: "connector",
        resource_id: id,
        result: "success",
        before: { ...prior, config: prior.config ?? {} },
        after: { ...row, config: row.config ?? {} },
        metadata: {},
      },
      tx,
    );
    return toView(row);
  });
  return updated;
}

export async function deleteConnector(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? getDb();
  const ok = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, tenant_id),
          eq(connectors.id, id),
          isNull(connectors.deleted_at),
        ),
      )
      .limit(1);
    if (!existing[0]) return false;
    await tx
      .update(connectors)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(eq(connectors.id, id));
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.CONNECTOR_DELETED,
        resource_type: "connector",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      tx,
    );
    return true;
  });
  return ok;
}
