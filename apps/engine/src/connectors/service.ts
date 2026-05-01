// Connector CRUD. Tenant + environment scoped. The service is the only
// place that touches the `connectors` table — routes call through it so
// audit rows and slug normalization land consistently.

import { and, desc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, getDb } from "../db/client.ts";
import { connectors } from "../db/schema/index.ts";
import { closePoolForConnector } from "./drivers/postgres.ts";
import { enrichConnectorFromTemplate } from "./template-enrichment.ts";
import { buildTemplateBindingFields, resolveConnectorTemplate } from "./template-resolver.ts";
import {
  type ConnectorView,
  type CreateConnectorInput,
  type DriverName,
  type Environment,
  HttpConnectorConfig,
  type UpdateConnectorInput,
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
    operator_notes: row.operator_notes ?? null,
    template_slug: row.template_slug ?? null,
    template_name: row.template_name ?? null,
    template_source: row.template_source ?? null,
    template_version: row.template_version ?? null,
    template_snapshot: (row.template_snapshot as Record<string, unknown> | null) ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    circuit_state: (row.circuit_state as ConnectorView["circuit_state"]) ?? "closed",
    circuit_opened_at: row.circuit_opened_at ?? null,
    circuit_failure_count: row.circuit_failure_count ?? 0,
    circuit_threshold: row.circuit_threshold ?? 5,
    circuit_reset_ms: row.circuit_reset_ms ?? 300000,
  };
}

function validateHttpConfig(driver: DriverName, config: Record<string, unknown> | undefined): void {
  if (driver !== "http" || !config) return;
  const parsed = HttpConnectorConfig.safeParse(config);
  if (!parsed.success) {
    throw Object.assign(new Error("invalid http connector config"), {
      code: "connector_config_invalid",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
}

async function resolveCreateTemplateBinding(
  tenant_id: string,
  input: CreateConnectorInput,
  exec: Executor,
): Promise<{
  effective: CreateConnectorInput;
  binding: ReturnType<typeof buildTemplateBindingFields> | null;
}> {
  if (!input.template_slug) {
    return { effective: input, binding: null };
  }
  const resolved = await resolveConnectorTemplate({
    db: exec,
    tenant_id,
    slug: input.template_slug,
    preferred_source: input.template_source,
  });
  if (!resolved) {
    throw Object.assign(new Error(`unknown connector template: ${input.template_slug}`), {
      code: "connector_template_unknown",
      template_slug: input.template_slug,
    });
  }
  const enriched = enrichConnectorFromTemplate(
    {
      name: input.name,
      slug: input.slug,
      driver: input.driver,
      environment: input.environment,
      base_url: input.base_url,
      dsn: input.dsn,
      auth_type: input.auth_type,
      config: input.config,
      operator_notes: input.operator_notes,
    },
    resolved.template,
    input.template_base_url_environment
      ? { environment: input.template_base_url_environment }
      : undefined,
  );
  return {
    effective: enriched,
    binding: buildTemplateBindingFields(resolved),
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
  return await db.transaction(async (tx) => {
    const resolved = await resolveCreateTemplateBinding(p.tenant_id, p.input, tx);
    const effective = resolved.effective;
    const slug = effective.slug ?? slugify(effective.name);
    const environment = effective.environment ?? "dev";
    const auth_type = effective.auth_type ?? "none";
    validateHttpConfig(effective.driver, effective.config);
    // Upsert semantics on (tenant_id, environment, slug): when a
    // connector with the same slug already exists in the same
    // environment, treat the call as an update rather than letting the
    // unique-constraint throw. Mirrors the reference impl's
    // `upsertSystem ON CONFLICT (id, environment, org_id) DO UPDATE`.
    // Pre-fix the LLM authoring flow looped here: re-running
    // start_connector_from_description with the same URL produced the
    // same slug, the insert threw `duplicate key violates …
    // connectors_tenant_environment_slug_idx`, and the LLM started
    // recreating workflows from scratch.
    const existingRows = await tx
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenant_id, p.tenant_id),
          eq(connectors.slug, slug),
          eq(connectors.environment, environment),
          isNull(connectors.deleted_at),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      const updated = await tx
        .update(connectors)
        .set({
          display_name: effective.name,
          driver: effective.driver,
          auth_type,
          base_url: effective.base_url ?? existing.base_url,
          dsn: effective.dsn ?? existing.dsn,
          config: effective.config ?? existing.config,
          operator_notes: effective.operator_notes ?? existing.operator_notes,
          ...(resolved.binding ?? {}),
          updated_at: new Date(),
        })
        .where(eq(connectors.id, existing.id))
        .returning();
      const row = updated[0] ?? existing;
      await auditAwait(
        {
          tenant_id: p.tenant_id,
          actor_type: p.actor_id ? "user" : "system",
          actor_id: p.actor_id,
          action: AuditAction.CONNECTOR_UPDATED,
          resource_type: "connector",
          resource_id: row.id,
          result: "success",
          reason: "upsert_on_slug_conflict",
          metadata: {
            slug,
            driver: effective.driver,
            environment,
            auth_type,
            template_slug: row.template_slug ?? null,
            template_source: row.template_source ?? null,
          },
        },
        tx,
      );
      return toView(row);
    }
    const inserted = await tx
      .insert(connectors)
      .values({
        tenant_id: p.tenant_id,
        slug,
        display_name: effective.name,
        driver: effective.driver,
        environment,
        auth_type,
        base_url: effective.base_url ?? null,
        dsn: effective.dsn ?? null,
        config: effective.config ?? {},
        operator_notes: effective.operator_notes ?? null,
        ...(resolved.binding ?? {
          template_slug: null,
          template_name: null,
          template_source: null,
          template_version: null,
          template_snapshot: null,
        }),
      })
      .returning();
    const row = inserted[0];
    assertInsertRow(row, "connectors");
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
          driver: effective.driver,
          environment,
          auth_type,
          template_slug: row.template_slug ?? null,
          template_source: row.template_source ?? null,
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
    if (patch.clear_template_binding && patch.template_slug) {
      throw Object.assign(
        new Error("clear_template_binding cannot be combined with template_slug"),
        { code: "connector_template_conflict" },
      );
    }
    const set: Partial<typeof connectors.$inferInsert> = { updated_at: new Date() };
    if (patch.name !== undefined) set.display_name = patch.name;
    if (patch.base_url !== undefined) set.base_url = patch.base_url;
    if (patch.dsn !== undefined) set.dsn = patch.dsn;
    if (patch.auth_type !== undefined) set.auth_type = patch.auth_type;
    if (patch.config !== undefined) set.config = patch.config;
    if (patch.operator_notes !== undefined) set.operator_notes = patch.operator_notes;
    if (patch.clear_template_binding) {
      set.template_slug = null;
      set.template_name = null;
      set.template_source = null;
      set.template_version = null;
      set.template_snapshot = null;
    } else if (patch.template_slug) {
      const resolved = await resolveConnectorTemplate({
        db: tx,
        tenant_id,
        slug: patch.template_slug,
        preferred_source: patch.template_source,
      });
      if (!resolved) {
        throw Object.assign(new Error(`unknown connector template: ${patch.template_slug}`), {
          code: "connector_template_unknown",
          template_slug: patch.template_slug,
        });
      }
      Object.assign(set, buildTemplateBindingFields(resolved));
      const enriched = enrichConnectorFromTemplate(
        {
          name: patch.name ?? prior.display_name,
          slug: prior.slug,
          driver: prior.driver as DriverName,
          environment: prior.environment as Environment,
          base_url: patch.base_url ?? prior.base_url ?? undefined,
          dsn: patch.dsn ?? prior.dsn ?? undefined,
          auth_type: patch.auth_type ?? (prior.auth_type as UpdateConnectorInput["auth_type"]),
          config: patch.config ?? (prior.config as Record<string, unknown>) ?? {},
        },
        resolved.template,
        patch.template_base_url_environment
          ? { environment: patch.template_base_url_environment }
          : undefined,
      );
      set.config = enriched.config ?? {};
      if (patch.base_url === undefined && !prior.base_url && enriched.base_url) {
        set.base_url = enriched.base_url;
      }
      if (patch.auth_type === undefined && prior.auth_type === "none") {
        set.auth_type = enriched.auth_type;
      }
    }
    validateHttpConfig(
      (prior.driver as DriverName) ?? "http",
      set.config as Record<string, unknown>,
    );
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
  // The transaction returns the row to evict (when one matches the
  // postgres-eviction policy). This avoids a side-channel `let` that
  // TS struggles to narrow across the async boundary.
  type EvictRow = {
    id: string;
    environment: "dev" | "prod";
    dsn: string | null;
    driver: string;
  };
  type DeleteResult = { ok: boolean; evict: EvictRow | null };
  const result: DeleteResult = await db.transaction(async (tx) => {
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
    if (!existing[0]) return { ok: false, evict: null };
    const evict = existing[0].driver === "postgres" ? (existing[0] as unknown as EvictRow) : null;
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
    return { ok: true, evict };
  });
  const ok = result.ok;
  // After the row is soft-deleted, evict the postgres pool so the
  // connector's connection pool doesn't linger until process restart.
  if (ok && result.evict) {
    await closePoolForConnector(result.evict as never).catch(() => {});
  }
  return ok;
}
