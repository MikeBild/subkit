// Connector CRUD. Tenant + environment scoped. The service is the only
// place that touches the `connectors` table — routes call through it so
// audit rows and slug normalization land consistently.

import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { type ListResult, resolveWindowTotal, totalOverWindow } from "../db/list-result.ts";
import { connectors, credentials } from "../db/schema/index.ts";
import { BadRequestError } from "../http/errors.ts";
import { evictServer as evictMcpServer } from "../mcp/client/pool.ts";
import {
  validateConnectorAuthType,
  validateConnectorConfigOrThrow,
  validateMcpAuthConsistency,
  withMcpConfigDefaults,
} from "./config-schemas.ts";
import { closePoolForConnector } from "./drivers/postgres.ts";
import { enrichConnectorFromTemplate } from "./template-enrichment.ts";
import { buildTemplateBindingFields, resolveConnectorTemplate } from "./template-resolver.ts";
import type {
  ConnectorSelfDescription,
  ConnectorSelfDescriptionLink,
  ConnectorView,
  CreateConnectorInput,
  DriverName,
  Environment,
  UpdateConnectorInput,
} from "./types.ts";

/**
 * Refuse an auth kind the driver cannot honour.
 *
 * A `BadRequestError` rather than a bare domain error because the plain
 * `Object.assign(new Error(), { code })` shape used elsewhere in this file is
 * not mapped by the HTTP error middleware and would surface as a 500 — a
 * misconfiguration the caller can fix must not read as an engine fault.
 */
function assertAuthTypeAllowedForDriver(
  driver: DriverName,
  auth_type: ConnectorView["auth_type"] | undefined,
): void {
  const issues = validateConnectorAuthType(driver, auth_type);
  const first = issues[0];
  if (!first) return;
  throw new BadRequestError(first.message, { field: first.path, driver });
}

function assertMcpAuthConfigConsistent(
  driver: DriverName,
  auth_type: ConnectorView["auth_type"],
  config: Record<string, unknown> | undefined,
): void {
  const first = validateMcpAuthConsistency(driver, auth_type, config)[0];
  if (!first) return;
  throw new BadRequestError(first.message, { field: first.path, driver });
}

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
    operator_quirks: ((row.operator_quirks as ConnectorView["operator_quirks"]) ??
      {}) as ConnectorView["operator_quirks"],
    template_slug: row.template_slug ?? null,
    template_name: row.template_name ?? null,
    template_source: row.template_source ?? null,
    template_version: row.template_version ?? null,
    template_snapshot: (row.template_snapshot as Record<string, unknown> | null) ?? null,
    self_description: (row.self_description as ConnectorView["self_description"]) ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    enabled: row.enabled ?? true,
    last_error: row.last_error ?? null,
    circuit_state: (row.circuit_state as ConnectorView["circuit_state"]) ?? "closed",
    circuit_opened_at: row.circuit_opened_at ?? null,
    circuit_failure_count: row.circuit_failure_count ?? 0,
    circuit_threshold: row.circuit_threshold ?? 5,
    circuit_reset_ms: row.circuit_reset_ms ?? 300000,
    needs_reauth: row.needs_reauth ?? false,
    auth_failed_at: row.auth_failed_at ?? null,
    auth_failed_reason: row.auth_failed_reason ?? null,
    health_state: row.health_state ?? "ok",
    health_reason: row.health_reason ?? null,
    health_error_code: row.health_error_code ?? null,
    sunset_at: row.sunset_at ?? null,
    successor_uri: row.successor_uri ?? null,
  };
}

// Config validation lives in `config-schemas.ts` so the write path, the
// validate endpoint and the CLI all reach the same verdict. This used to be an
// HTTP-only check that returned early for every other driver, which is how a
// graphql or s3 config could be stored and then fail at call time instead.

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
      operator_quirks: input.operator_quirks,
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
    const resolvedEffective = resolved.effective;
    const auth_type = resolvedEffective.auth_type ?? "none";
    const effective = {
      ...resolvedEffective,
      config: withMcpConfigDefaults(resolvedEffective.driver, auth_type, resolvedEffective.config),
    };
    const slug = effective.slug ?? slugify(effective.name);
    const environment = effective.environment ?? "dev";
    assertAuthTypeAllowedForDriver(effective.driver, auth_type);
    validateConnectorConfigOrThrow(effective.driver, effective.config);
    assertMcpAuthConfigConsistent(effective.driver, auth_type, effective.config);
    // Upsert semantics on (tenant_id, environment, slug): when a
    // connector with the same slug already exists in the same
    // environment, treat the call as an update rather than letting the
    // unique-constraint throw (an `ON CONFLICT ... DO UPDATE`
    // equivalent on (tenant_id, environment, slug)). Without this the
    // LLM authoring flow looped here: re-running
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
          operator_quirks: effective.operator_quirks ?? existing.operator_quirks,
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
        // Never persist a blank name — conversational drafts sometimes carry
        // only a slug, which left the connector list showing an empty name.
        display_name: effective.name || slug,
        driver: effective.driver,
        environment,
        auth_type,
        base_url: effective.base_url ?? null,
        dsn: effective.dsn ?? null,
        config: effective.config ?? {},
        operator_quirks: effective.operator_quirks ?? {},
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

/**
 * Connectors are a bounded business catalog — the default page IS the
 * safety bound so enumeration surfaces see the complete set unless a
 * caller explicitly pages. `total` is the exact tenant-scoped count
 * under the same filters (window count, no second round trip).
 */
export const CONNECTOR_LIST_MAX_LIMIT = 1000;

export async function listConnectors(
  tenant_id: string,
  opts: {
    environment?: Environment;
    /**
     * Catalog block. Connector slugs are single tokens, so unlike workflows
     * there is nothing to derive: a connector's category IS its driver
     * (`workflows/categorize.ts#categoryOfConnector`), which makes this a
     * plain stored-column filter.
     */
    category?: string;
    enabled?: boolean;
    health_state?: string;
    q?: string;
    sort?: "name" | "driver" | "environment" | "enabled" | "updated_at";
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {},
  exec?: Executor,
): Promise<ListResult<ConnectorView>> {
  const db = exec ?? getDb();
  const tenantConds = [eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)];
  if (opts.environment) tenantConds.push(eq(connectors.environment, opts.environment));
  if (opts.category) tenantConds.push(eq(connectors.driver, opts.category));
  if (opts.enabled !== undefined) tenantConds.push(eq(connectors.enabled, opts.enabled));
  if (opts.health_state) tenantConds.push(eq(connectors.health_state, opts.health_state));
  if (opts.q) {
    const needle = `%${opts.q}%`;
    const search = or(
      ilike(connectors.display_name, needle),
      ilike(connectors.slug, needle),
      ilike(connectors.driver, needle),
      ilike(connectors.base_url, needle),
    );
    if (search) tenantConds.push(search);
  }
  const offset = opts.offset ?? 0;
  const sortColumn =
    opts.sort === "name"
      ? connectors.display_name
      : opts.sort === "driver"
        ? connectors.driver
        : opts.sort === "environment"
          ? connectors.environment
          : opts.sort === "enabled"
            ? connectors.enabled
            : opts.sort === "updated_at"
              ? connectors.updated_at
              : connectors.created_at;
  const ordered = opts.order === "asc" ? asc(sortColumn) : desc(sortColumn);
  const rows = await db
    .select({ row: connectors, total: totalOverWindow() })
    .from(connectors)
    .where(and(...tenantConds))
    .orderBy(ordered, asc(connectors.id))
    .limit(Math.min(opts.limit ?? CONNECTOR_LIST_MAX_LIMIT, CONNECTOR_LIST_MAX_LIMIT))
    .offset(offset);
  const total = await resolveWindowTotal(rows, offset, async () => {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(connectors)
      .where(and(...tenantConds));
    return Number(row?.c ?? 0);
  });
  return { rows: rows.map((r) => toView(r.row)), total };
}

/**
 * Catalog block sizes, counted over every connector of the tenant. List
 * callers render these as filter chips, so they must not shrink to whatever
 * the current page or filter happens to contain.
 */
export async function connectorCategoryCounts(
  tenant_id: string,
  exec?: Executor,
): Promise<Map<string, number>> {
  const db = exec ?? getDb();
  const rows = await db
    .select({ driver: connectors.driver, count: sql<number>`count(*)::int` })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)))
    .groupBy(connectors.driver);
  return new Map(rows.map((r) => [r.driver, Number(r.count)]));
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

export interface CredentialSummary {
  id: string;
  mode: string;
  environment: string;
  has_oauth_refresh: boolean;
  granted_scopes: string | null;
  oauth2_expires_at: string | null;
  created_at: string;
}

/**
 * Redacted credential summaries for a connector — what's attached, never the
 * secret. Powers `sk credentials list` and the single-connector GET view so an
 * operator who runs `sk credentials set` can confirm the credential landed.
 */
export async function listConnectorCredentials(
  tenant_id: string,
  connector_id: string,
  exec?: Executor,
): Promise<CredentialSummary[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select({
      id: credentials.id,
      mode: credentials.mode,
      environment: credentials.environment,
      oauth2_refresh_ciphertext: credentials.oauth2_refresh_ciphertext,
      granted_scopes: credentials.granted_scopes,
      oauth2_expires_at: credentials.oauth2_expires_at,
      created_at: credentials.created_at,
    })
    .from(credentials)
    .where(
      and(
        eq(credentials.tenant_id, tenant_id),
        eq(credentials.connector_id, connector_id),
        isNull(credentials.deleted_at),
      ),
    )
    .orderBy(desc(credentials.created_at));
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    environment: r.environment,
    has_oauth_refresh: r.oauth2_refresh_ciphertext != null,
    granted_scopes: r.granted_scopes,
    oauth2_expires_at: r.oauth2_expires_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  }));
}

/**
 * Pure circuit-breaker gate: true while the connector's breaker is open AND
 * the reset window has not yet elapsed. This is the single predicate behind
 * the dispatch-time `circuit_open` short-circuit — a `true` here means a
 * request against this connector fails fast without touching the upstream.
 * A stale open breaker (reset window elapsed, or no opened_at stamp) returns
 * false so the caller lets a probe through to transition to half-open.
 * Fan-out callers (`for_each` in the engine) use it to fail ONCE at the
 * container instead of scheduling N doomed iterations.
 */
export function isCircuitOpenBlocking(
  connector: Pick<ConnectorView, "circuit_state" | "circuit_opened_at" | "circuit_reset_ms">,
  now_ms: number = Date.now(),
): boolean {
  if (connector.circuit_state !== "open") return false;
  if (connector.circuit_opened_at === null) return false;
  return now_ms - connector.circuit_opened_at.getTime() < connector.circuit_reset_ms;
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
    if (patch.operator_quirks !== undefined) set.operator_quirks = patch.operator_quirks;
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
    // `set.config` is only populated when the patch actually carries one, so
    // driver-schema validation leaves a pre-existing config untouched. MCP
    // auth consistency still uses the effective stored-plus-patched pair.
    // `connectors.driver` is NOT NULL, so there is no absent case to
    // default. A `?? "http"` here would validate (say) an mcp config
    // against the strict HTTP schema and reject it with HTTP field names —
    // a wrong error pointing at the wrong layer.
    // `prior.driver` and not the patch: `driver` is not patchable, so the
    // connector's driver at rest is the one that will have to honour whatever
    // auth kind this patch lands.
    assertAuthTypeAllowedForDriver(
      prior.driver as DriverName,
      (set.auth_type ?? prior.auth_type) as ConnectorView["auth_type"],
    );
    validateConnectorConfigOrThrow(
      prior.driver as DriverName,
      set.config as Record<string, unknown>,
    );
    assertMcpAuthConfigConsistent(
      prior.driver as DriverName,
      (set.auth_type ?? prior.auth_type) as ConnectorView["auth_type"],
      (set.config ?? prior.config ?? {}) as Record<string, unknown>,
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

/**
 * Flip the operator on/off switch, driver-agnostic.
 *
 * `enabled` is the one bit only a human sets — distinct from `health_state`
 * (a verdict the engine derives) and from `deleted_at` (gone). Disabling
 * keeps the row and its credentials intact and simply stops offering the
 * connector for use.
 *
 * DRIVER DISPATCH ON THE WAY OUT: an `mcp` connector holds a live pooled
 * SDK session and a cached tool manifest that outlive the row read, and a
 * `postgres` connector holds a live pg pool. Neither notices a column
 * change, so a disable that did not evict would keep serving the thing it
 * just turned off until the process restarted.
 *
 * Returns null when no live connector matches, and the updated view
 * otherwise — including when the bit was already in the requested state,
 * because "disable an already-disabled connector" is a success, not a
 * missing row.
 */
export async function setConnectorEnabled(
  tenant_id: string,
  id: string,
  enabled: boolean,
  actor_id: string | null,
  exec?: Executor,
): Promise<ConnectorView | null> {
  const db = exec ?? getDb();
  const [row] = await db
    .update(connectors)
    .set({ enabled, updated_at: new Date() })
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.id, id),
        isNull(connectors.deleted_at),
      ),
    )
    .returning();
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
      reason: enabled ? "enabled" : "disabled",
      metadata: { driver: row.driver, enabled },
    },
    db,
  );
  if (row.driver === "mcp") evictMcpServer(tenant_id, id);
  const view = toView(row);
  if (row.driver === "postgres") await closePoolForConnector(view);
  return view;
}

export async function deleteConnector(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
  // When the delete was confirmed despite live workflows binding this
  // connector, the caller passes their ids so the single CONNECTOR_DELETED
  // audit row records "operator was warned about N broken workflows and
  // proceeded anyway" — the governance breadcrumb for an orphaning delete.
  opts?: { orphaned_workflow_ids?: string[] },
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
  type DeleteResult = { ok: boolean; evict: EvictRow | null; evict_mcp: boolean };
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
    if (!existing[0]) return { ok: false, evict: null, evict_mcp: false };
    const evict = existing[0].driver === "postgres" ? (existing[0] as unknown as EvictRow) : null;
    // An mcp connector's live SDK client and cached manifest live in the
    // per-tenant MCP pool, not in this process's connector row. Deleting
    // the row without evicting would leave the socket open and the
    // manifest servable until the process restarts.
    const evict_mcp = existing[0].driver === "mcp";
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
        ...((opts?.orphaned_workflow_ids?.length ?? 0) > 0
          ? { reason: "delete_with_orphaned_workflows" }
          : {}),
        metadata:
          (opts?.orphaned_workflow_ids?.length ?? 0) > 0
            ? {
                orphaned_workflow_ids: opts?.orphaned_workflow_ids,
                orphaned_workflow_count: opts?.orphaned_workflow_ids?.length,
              }
            : {},
      },
      tx,
    );
    return { ok: true, evict, evict_mcp };
  });
  const ok = result.ok;
  // After the row is soft-deleted, evict the postgres pool so the
  // connector's connection pool doesn't linger until process restart.
  if (ok && result.evict) {
    await closePoolForConnector(result.evict as never).catch(() => {});
  }
  if (ok && result.evict_mcp) {
    evictMcpServer(tenant_id, id);
  }
  return ok;
}

/**
 * Non-destructive upsert of connector self-description LINKS (llms.txt /
 * llms-full / OpenAPI / GraphQL). LINKS ONLY — never document bodies. At most
 * one link per `kind`; the newest `discovered_at` wins. Only the
 * `self_description` column is touched, so it never disturbs a working
 * connector's config/auth. Used by create-time link capture and the
 * self-healing enrichment pass. Returns the merged links (or null if the
 * connector row is gone).
 */
export async function attachConnectorSelfDescriptionLinks(
  p: {
    tenant_id: string;
    connector_id: string;
    links: ConnectorSelfDescriptionLink[];
  },
  exec?: Executor,
): Promise<ConnectorSelfDescriptionLink[] | null> {
  if (p.links.length === 0) return null;
  const db = exec ?? getDb();
  const rows = await db
    .select({ self_description: connectors.self_description })
    .from(connectors)
    .where(and(eq(connectors.id, p.connector_id), eq(connectors.tenant_id, p.tenant_id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const current = (row.self_description as ConnectorSelfDescription) ?? {};
  const byKind = new Map<string, ConnectorSelfDescriptionLink>();
  for (const link of [...(current.links ?? []), ...p.links]) {
    const existing = byKind.get(link.kind);
    // Newest discovered_at wins; incoming wins ties (it was just observed).
    if (!existing || link.discovered_at >= existing.discovered_at) byKind.set(link.kind, link);
  }
  const merged = [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));

  await db
    .update(connectors)
    .set({ self_description: { links: merged } })
    .where(and(eq(connectors.id, p.connector_id), eq(connectors.tenant_id, p.tenant_id)));
  return merged;
}
