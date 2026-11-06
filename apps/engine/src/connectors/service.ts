import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type CatalogGroupBy,
  type CatalogMetadataPatch,
  catalogMetadataView,
  humanMetadataWrite,
  metadataChange,
} from "../api/catalog-metadata.ts";
import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { storedScopes } from "../credentials/authority-scopes.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import {
  catalogGroupOrder,
  type ListResult,
  resolveWindowTotal,
  totalOverWindow,
} from "../db/list-result.ts";
import { connectors, credentials } from "../db/schema/index.ts";
import { BadRequestError } from "../http/errors.ts";
import { evictServer as evictMcpServer } from "../mcp/client/pool.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import {
  validateConnectorAuthType,
  validateConnectorConfigOrThrow,
  validateMcpAuthConsistency,
  validateSignedJwtAuthConfig,
  withMcpConfigDefaults,
} from "./config-schemas.ts";
import { closePoolForConnector } from "./drivers/postgres.ts";
import { connectorCountsAgainstHealth } from "./health-ratio.ts";
import { carryMcpTrustList } from "./mcp-tool-trust.ts";
import { restoreMaskedConnectorSecrets, toPublicConnector } from "./public-view.ts";
import { validateTemplateSignedJwtPolicy } from "./template-binding.ts";
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

function assertSignedJwtAuthConfig(
  auth_type: ConnectorView["auth_type"],
  config: Record<string, unknown> | undefined,
): void {
  const first = validateSignedJwtAuthConfig(auth_type, config)[0];
  if (!first) return;
  throw new BadRequestError(first.message, { field: first.path });
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

function metadataPatchOf(input: {
  accept_description?: boolean | undefined;
  description?: string | null | undefined;
  category?: string | null | undefined;
}): CatalogMetadataPatch {
  return {
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.accept_description !== undefined
      ? { accept_description: input.accept_description }
      : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
  };
}

function toView(row: typeof connectors.$inferSelect): ConnectorView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    ...catalogMetadataView(row),
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
    effective: {
      ...enriched,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
    },
    binding: buildTemplateBindingFields(resolved),
  };
}

interface CreateConnectorParams {
  tenant_id: string;
  input: CreateConnectorInput;
  actor_id: string | null;
  actor?: Actor | { kind: "unknown" } | null;
  actor_type?: AuditActorType;
}

function connectorAuditActor(p: {
  actor?: Actor | { kind: "unknown" } | null;
  actor_id?: string | null;
  actor_type?: AuditActorType;
}): { actor_type: AuditActorType; actor_id: string | null } {
  if (p.actor !== undefined) {
    if (p.actor && p.actor.kind !== "unknown") return auditActor(p.actor);
    if (p.actor?.kind === "unknown") return { actor_type: "unknown", actor_id: null };
    return p.actor_id ? { actor_type: "unknown", actor_id: null } : auditActor(null);
  }
  if (p.actor_type === "unknown") return { actor_type: "unknown", actor_id: null };
  if (p.actor_type) return { actor_type: p.actor_type, actor_id: p.actor_id ?? null };
  return p.actor_id ? { actor_type: "unknown", actor_id: null } : auditActor(null);
}

type ConnectorActorInput = Actor | { kind: "unknown" } | string | null;

function connectorActorFields(actor_input: ConnectorActorInput) {
  if (typeof actor_input === "string" || actor_input?.kind === "unknown")
    return { actor_type: "unknown" as const, actor_id: null };
  return auditActor(actor_input);
}

export async function createConnector(
  p: CreateConnectorParams,
  db: Executor,
): Promise<ConnectorView> {
  return await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, p.tenant_id);
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
    assertSignedJwtAuthConfig(auth_type, effective.config);
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
    const secrets = restoreMaskedConnectorSecrets(
      { base_url: effective.base_url, config: effective.config, dsn: effective.dsn },
      existing ?? null,
      {
        template_rebound:
          resolved.binding != null && resolved.binding.template_slug !== existing?.template_slug,
      },
    );
    const config = carryMcpTrustList(
      effective.driver,
      existing?.driver === effective.driver ? existing.config : null,
      secrets.config,
    );
    if (existing) {
      const updated = await tx
        .update(connectors)
        .set({
          display_name: effective.name,
          driver: effective.driver,
          auth_type,
          base_url: secrets.base_url ?? existing.base_url,
          dsn: secrets.dsn ?? existing.dsn,
          config: config ?? existing.config,
          operator_quirks: effective.operator_quirks ?? existing.operator_quirks,
          ...metadataChange(existing, metadataPatchOf(effective)),
          ...(resolved.binding ?? {}),
          updated_at: new Date(),
        })
        .where(eq(connectors.id, existing.id))
        .returning();
      const row = updated[0] ?? existing;
      await auditAwait(
        {
          tenant_id: p.tenant_id,
          ...connectorAuditActor(p),
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
      await emitResourceChange(tx, {
        tenant_id: p.tenant_id,
        type: "connector.updated",
        ids: { connector_id: row.id },
      });
      return toView(row);
    }
    const inserted = await tx
      .insert(connectors)
      .values({
        tenant_id: p.tenant_id,
        slug,
        display_name: effective.name || slug,
        driver: effective.driver,
        environment,
        auth_type,
        base_url: secrets.base_url ?? null,
        dsn: secrets.dsn ?? null,
        config: config ?? {},
        operator_quirks: effective.operator_quirks ?? {},
        ...humanMetadataWrite(metadataPatchOf(effective)),
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
        ...connectorAuditActor(p),
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
    await emitResourceChange(tx, {
      tenant_id: p.tenant_id,
      type: "connector.created",
      ids: { connector_id: row.id },
    });
    return toView(row);
  });
}

const CONNECTOR_LIST_MAX_LIMIT = 1000;

export async function listConnectors(
  tenant_id: string,
  opts: {
    environment?: Environment;
    category?: string;
    driver?: string;
    kind?: "oauth" | "mcp" | "key";
    description_source?: "llm" | "human";
    enabled?: boolean;
    health_state?: string;
    health?: "not_ok";
    needs_reauth?: boolean;
    q?: string;
    sort?: "name" | "driver" | "environment" | "enabled" | "updated_at";
    group_by?: CatalogGroupBy;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {},
  db: Executor,
): Promise<ListResult<ConnectorView>> {
  const tenantConds = [eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)];
  if (opts.environment) tenantConds.push(eq(connectors.environment, opts.environment));
  if (opts.category) tenantConds.push(eq(connectors.category, opts.category));
  if (opts.description_source)
    tenantConds.push(eq(connectors.description_source, opts.description_source));
  if (opts.description_source === "llm")
    tenantConds.push(sql`length(trim(coalesce(${connectors.description}, ''))) > 0`);
  if (opts.driver) tenantConds.push(eq(connectors.driver, opts.driver));
  if (opts.kind === "mcp") tenantConds.push(eq(connectors.driver, "mcp"));
  if (opts.kind === "oauth") {
    tenantConds.push(
      sql`${connectors.driver} <> 'mcp' AND ${connectors.auth_type} IN ('oauth2', 'oauth2_client', 'oauth2_private_key')`,
    );
  }
  if (opts.kind === "key") {
    tenantConds.push(
      sql`${connectors.driver} <> 'mcp' AND ${connectors.auth_type} IN ('header', 'query', 'bearer', 'basic', 'aws_sigv4')`,
    );
  }
  if (opts.enabled !== undefined) tenantConds.push(eq(connectors.enabled, opts.enabled));
  if (opts.health_state) tenantConds.push(eq(connectors.health_state, opts.health_state));
  if (opts.health === "not_ok") tenantConds.push(connectorCountsAgainstHealth());
  if (opts.needs_reauth !== undefined)
    tenantConds.push(eq(connectors.needs_reauth, opts.needs_reauth));
  if (opts.q) {
    const needle = `%${opts.q}%`;
    const search = or(
      ilike(connectors.display_name, needle),
      ilike(connectors.slug, needle),
      ilike(connectors.driver, needle),
      ilike(connectors.category, needle),
      ilike(connectors.description, needle),
      ilike(connectors.base_url, needle),
    );
    if (search) tenantConds.push(search);
  }
  const offset = opts.offset ?? 0;
  const sortColumn =
    opts.sort === "name"
      ? sql`lower(${connectors.display_name})`
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
    .orderBy(...catalogGroupOrder(opts.group_by, connectors.category), ordered, asc(connectors.id))
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

export async function connectorCategoryCounts(
  tenant_id: string,
  db: Executor,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ category: connectors.category, count: sql<number>`count(*)::int` })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)))
    .groupBy(connectors.category);
  return new Map(rows.map((r) => [r.category, Number(r.count)]));
}

export async function getConnector(
  tenant_id: string,
  id: string,
  db: Executor,
): Promise<ConnectorView | null> {
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

export async function getConnectorForDefinition(
  tenant_id: string,
  definition: Pick<CreateConnectorInput, "name" | "slug" | "environment">,
  db: Executor,
): Promise<ConnectorView | null> {
  const rows = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        eq(connectors.slug, definition.slug ?? slugify(definition.name)),
        eq(connectors.environment, definition.environment ?? "dev"),
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
  connection_id: string | null;
  created_at: string;
}

export async function listConnectorCredentials(
  tenant_id: string,
  connector_id: string,
  db: Executor,
): Promise<CredentialSummary[]> {
  const rows = await db
    .select({
      id: credentials.id,
      mode: credentials.mode,
      environment: credentials.environment,
      oauth2_refresh_ciphertext: credentials.oauth2_refresh_ciphertext,
      granted_scopes: credentials.granted_scopes,
      oauth2_expires_at: credentials.oauth2_expires_at,
      connection_id: credentials.connection_id,
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
    granted_scopes: storedScopes(r.granted_scopes),
    oauth2_expires_at: r.oauth2_expires_at?.toISOString() ?? null,
    connection_id: r.connection_id,
    created_at: r.created_at.toISOString(),
  }));
}

export function isCircuitOpenBlocking(
  connector: Pick<ConnectorView, "circuit_state" | "circuit_opened_at" | "circuit_reset_ms">,
  now_ms: number = Date.now(),
): boolean {
  if (connector.circuit_state !== "open") return false;
  if (connector.circuit_opened_at === null) return false;
  return now_ms - connector.circuit_opened_at.getTime() < connector.circuit_reset_ms;
}

export interface ConnectorEnvironmentRequest {
  connector_id: string;
  environment: Environment;
}

export function connectorEnvironmentKey(connector_id: string, environment: Environment): string {
  return `${connector_id}:${environment}`;
}

export async function getConnectorsForEnvironments(
  tenant_id: string,
  requests: readonly ConnectorEnvironmentRequest[],
  db: Executor,
): Promise<Map<string, ConnectorView | null>> {
  const result = new Map<string, ConnectorView | null>();
  if (requests.length === 0) return result;
  const bases = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        inArray(connectors.id, [...new Set(requests.map((request) => request.connector_id))]),
        isNull(connectors.deleted_at),
      ),
    );
  const byId = new Map(bases.map((row) => [row.id, row]));
  const slugs = [
    ...new Set(
      requests.flatMap((request) => {
        const base = byId.get(request.connector_id);
        return base && base.environment !== request.environment ? [base.slug] : [];
      }),
    ),
  ];
  const variants =
    slugs.length === 0
      ? []
      : await db
          .select()
          .from(connectors)
          .where(
            and(
              eq(connectors.tenant_id, tenant_id),
              inArray(connectors.slug, slugs),
              inArray(connectors.environment, [
                ...new Set(requests.map((request) => request.environment)),
              ]),
              isNull(connectors.deleted_at),
            ),
          );
  const bySlugEnvironment = new Map(variants.map((row) => [`${row.slug}:${row.environment}`, row]));
  for (const request of requests) {
    const base = byId.get(request.connector_id);
    const row =
      base && base.environment !== request.environment
        ? (bySlugEnvironment.get(`${base.slug}:${request.environment}`) ?? base)
        : base;
    result.set(
      connectorEnvironmentKey(request.connector_id, request.environment),
      row ? toView(row) : null,
    );
  }
  return result;
}

export async function getConnectorForEnvironment(
  tenant_id: string,
  id: string,
  environment: Environment,
  db: Executor,
): Promise<ConnectorView | null> {
  const rows = await getConnectorsForEnvironments(
    tenant_id,
    [{ connector_id: id, environment }],
    db,
  );
  return rows.get(connectorEnvironmentKey(id, environment)) ?? null;
}

function oauthScopeOf(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const oauth = (config as Record<string, unknown>).oauth;
  if (!oauth || typeof oauth !== "object") return null;
  const scope = (oauth as Record<string, unknown>).scope;
  return typeof scope === "string" && scope.trim() ? scope.trim() : null;
}

export async function updateConnector(
  tenant_id: string,
  id: string,
  requested: UpdateConnectorInput,
  actor_input: ConnectorActorInput,
  db: Executor,
): Promise<ConnectorView | null> {
  const actorFields = connectorActorFields(actor_input);
  const updated = await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenant_id);
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
      .limit(1)
      .for("update");
    const prior = existing[0];
    if (!prior) return null;
    const patch = restoreMaskedConnectorSecrets(requested, prior, {
      template_rebound:
        requested.clear_template_binding === true ||
        (requested.template_slug != null && requested.template_slug !== prior.template_slug),
    });
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
    Object.assign(set, metadataChange(prior, metadataPatchOf(patch)));
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
    assertSignedJwtAuthConfig(
      (set.auth_type ?? prior.auth_type) as ConnectorView["auth_type"],
      (set.config ?? prior.config ?? {}) as Record<string, unknown>,
    );
    const policyIssue = validateTemplateSignedJwtPolicy({
      auth_type: (set.auth_type ?? prior.auth_type) as ConnectorView["auth_type"],
      config: (set.config ?? prior.config ?? {}) as Record<string, unknown>,
      template_snapshot: Object.hasOwn(set, "template_snapshot")
        ? ((set.template_snapshot as Record<string, unknown> | null) ?? null)
        : ((prior.template_snapshot as Record<string, unknown> | null) ?? null),
    });
    if (policyIssue) throw new BadRequestError(policyIssue.message, { field: policyIssue.field });
    if (set.config !== undefined) {
      set.config = carryMcpTrustList(
        prior.driver,
        prior.config,
        set.config as Record<string, unknown>,
      );
    }
    if (
      set.config !== undefined &&
      (set.auth_type ?? prior.auth_type) === "oauth2" &&
      oauthScopeOf(set.config) !== oauthScopeOf(prior.config)
    ) {
      set.needs_reauth = true;
      set.auth_failed_at = new Date();
      set.auth_failed_reason = "oauth scope changed — sign in again to grant it";
    }
    const [row] = await tx.update(connectors).set(set).where(eq(connectors.id, id)).returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id,
        ...actorFields,
        action: AuditAction.CONNECTOR_UPDATED,
        resource_type: "connector",
        resource_id: id,
        result: "success",
        before: toPublicConnector(prior),
        after: toPublicConnector(row),
        metadata: {},
      },
      tx,
    );
    await emitResourceChange(tx, {
      tenant_id,
      type: "connector.updated",
      ids: { connector_id: id },
    });
    return toView(row);
  });
  return updated;
}

export async function setConnectorEnabled(
  tenant_id: string,
  id: string,
  enabled: boolean,
  actor_input: ConnectorActorInput,
  db: Executor,
): Promise<ConnectorView | null> {
  const actorFields = connectorActorFields(actor_input);
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
      ...actorFields,
      action: AuditAction.CONNECTOR_UPDATED,
      resource_type: "connector",
      resource_id: id,
      result: "success",
      reason: enabled ? "enabled" : "disabled",
      metadata: { driver: row.driver, enabled },
    },
    db,
  );
  await emitResourceChange(db, {
    tenant_id,
    type: "connector.updated",
    ids: { connector_id: id },
  });
  if (row.driver === "mcp") evictMcpServer(tenant_id, id);
  const view = toView(row);
  if (row.driver === "postgres") await closePoolForConnector(view);
  return view;
}

export async function deleteConnector(
  tenant_id: string,
  id: string,
  actor_input: ConnectorActorInput,
  db: Executor,
  opts?: { orphaned_workflow_ids?: string[] },
): Promise<boolean> {
  const actorFields = connectorActorFields(actor_input);
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
    const evict_mcp = existing[0].driver === "mcp";
    await tx
      .update(connectors)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(eq(connectors.id, id));
    await auditAwait(
      {
        tenant_id,
        ...actorFields,
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
    await emitResourceChange(tx, {
      tenant_id,
      type: "connector.deleted",
      ids: { connector_id: id },
    });
    return { ok: true, evict, evict_mcp };
  });
  const ok = result.ok;
  if (ok && result.evict) {
    await closePoolForConnector(result.evict as never).catch(() => {});
  }
  if (ok && result.evict_mcp) {
    evictMcpServer(tenant_id, id);
  }
  return ok;
}

export async function attachConnectorSelfDescriptionLinks(
  p: {
    tenant_id: string;
    connector_id: string;
    links: ConnectorSelfDescriptionLink[];
  },
  db: Executor,
): Promise<ConnectorSelfDescriptionLink[] | null> {
  if (p.links.length === 0) return null;
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
    if (!existing || link.discovered_at >= existing.discovered_at) byKind.set(link.kind, link);
  }
  const merged = [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));

  await db
    .update(connectors)
    .set({ self_description: { links: merged } })
    .where(and(eq(connectors.id, p.connector_id), eq(connectors.tenant_id, p.tenant_id)));
  return merged;
}
