import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { runDiscoveryCached } from "../../connectors/discovery/service.ts";
import { connectorObservations } from "../../connectors/observations.ts";
import { toPublicConnector } from "../../connectors/public-view.ts";
import {
  connectorCategoryCounts,
  createConnectorOutcome,
  deleteConnector,
  getConnector,
  listConnectorCredentials,
  listConnectors,
  setConnectorEnabled,
  updateConnectorOutcome,
} from "../../connectors/service.ts";
import {
  type ConnectorView,
  type CreateConnectorInput,
  CreateConnectorSchema,
  type UpdateConnectorInput,
  UpdateConnectorSchema,
} from "../../connectors/types.ts";
import { summarizeConnections } from "../../credentials/connections/service.ts";
import { describeConnectorCredentialStates } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { describeConnectorPlaceholders } from "../../llm/substitution/resolver.ts";
import { logger } from "../../logging/index.ts";
import {
  CatalogGroupBySchema,
  compareCategoryCounts,
  listedDescription,
} from "../catalog-metadata.ts";
import { IdParam } from "../common-schemas.ts";
import { ConnectorListResponse, ConnectorSchema, serialize } from "./connector-representation.ts";
import { connectorWriteRejection } from "./connector-write-rejection.ts";
import { defineOperation, isRejection, type OperationScope, reject } from "./index.ts";

const ListConnectorsQuery = z
  .object({
    environment: z.enum(["dev", "prod"]).optional(),
    kind: z
      .enum(["oauth", "mcp", "key"])
      .optional()
      .describe(
        "MCP takes precedence over authentication kind. OAuth selects non-MCP OAuth connectors; key selects non-MCP header, query, bearer, basic or AWS signature authentication. Unauthenticated connectors remain in the unfiltered list.",
      ),
    enabled: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    health_state: z
      .enum(["ok", "degraded", "needs_reauth", "needs_update", "needs_attention"])
      .optional(),
    health: z
      .enum(["not_ok"])
      .optional()
      .describe(
        "`not_ok`: only the connectors that count against the connector-health ratio of the operational overview — enabled and any health state but `ok`. `total` and paging apply to the narrowed list; combined with `enabled=false` the list is empty.",
      ),
    q: z.string().min(1).max(200).optional(),
    sort: z.enum(["name", "driver", "environment", "enabled", "updated_at"]).optional(),
    group_by: CatalogGroupBySchema.optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    description_source: z.enum(["llm", "human"]).optional(),
    category: z
      .string()
      .optional()
      .describe("Only connectors in this catalog block (see the `category` field on each item)"),
    driver: z
      .string()
      .optional()
      .describe("Only connectors of this driver (http, graphql, postgres, s3, mcp, …)"),
  })
  .openapi("ListConnectorsQuery");

const ListConnectorsToolInput = z
  .object({
    category: z
      .string()
      .optional()
      .describe(
        "Only connectors in this catalog block. Categories are shared with workflows, knowledge sources, skills and files; read one from a previous list rather than inventing one.",
      ),
    driver: z
      .string()
      .optional()
      .describe("Only connectors of this driver (http, graphql, postgres, s3, sftp, mcp)."),
  })
  .openapi("ListConnectorsToolInput");

const GetConnectorToolInput = z
  .object({ id: z.string().uuid("connector id must be a UUID") })
  .openapi("GetConnectorToolInput");

type ListQuery = z.infer<typeof ListConnectorsQuery>;
type ListToolArgs = z.infer<typeof ListConnectorsToolInput>;
type GetToolArgs = z.infer<typeof GetConnectorToolInput>;
type ListOptions = Parameters<typeof listConnectors>[1];
type Observation =
  Awaited<ReturnType<typeof connectorObservations>> extends Map<string, infer V> ? V : never;
type CredentialState =
  Awaited<ReturnType<typeof describeConnectorCredentialStates>> extends Map<string, infer V>
    ? V
    : never;
type Placeholders = Awaited<ReturnType<typeof describeConnectorPlaceholders>>;

function listOptionsFromQuery(q: ListQuery): ListOptions {
  const opts: ListOptions = {};
  if (q.environment) opts.environment = q.environment;
  if (q.category) opts.category = q.category;
  if (q.description_source) opts.description_source = q.description_source;
  if (q.driver) opts.driver = q.driver;
  if (q.kind) opts.kind = q.kind;
  if (q.enabled !== undefined) opts.enabled = q.enabled;
  if (q.health_state) opts.health_state = q.health_state;
  if (q.health) opts.health = q.health;
  if (q.q) opts.q = q.q;
  if (q.sort) opts.sort = q.sort;
  if (q.order) opts.order = q.order;
  if (q.group_by) opts.group_by = q.group_by;
  if (q.limit !== undefined) opts.limit = q.limit;
  if (q.offset !== undefined) opts.offset = q.offset;
  return opts;
}

async function warmGraphqlSchema(
  db: Db,
  tenant_id: string,
  actor_type: "user" | "system_account",
  actor_id: string | null,
  connector: { id: string; driver: string; base_url: string | null },
): Promise<void> {
  if (connector.driver !== "graphql" || !connector.base_url) return;
  try {
    await runDiscoveryCached(
      { db, tenant_id, actor_type, actor_id, abortSignal: AbortSignal.timeout(6_000) },
      { base_url: connector.base_url, connector_id: connector.id },
    );
  } catch (err) {
    logger.warn({
      module: "connectors",
      action: "graphql_schema_warm.failed",
      connector_id: connector.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface ConnectorListInput {
  readonly options: ListOptions;
  readonly catalog: boolean;
}

interface ConnectorListResult {
  readonly rows: ConnectorView[];
  readonly total: number;
  readonly observations: Map<string, Observation>;
  readonly credentialStates: Map<string, CredentialState>;
  readonly categories: { category: string; count: number }[];
}

export const listConnectorsOperation = defineOperation<ConnectorListInput, ConnectorListResult>({
  id: "connector.list",
  summary: "List connectors",
  permission: "connector:read",
  effect: "read",
  async handler(scope, { options, catalog }) {
    const { rows, total } = await listConnectors(scope.tenant_id, options, scope.db);
    if (!catalog) {
      return { rows, total, observations: new Map(), credentialStates: new Map(), categories: [] };
    }
    const observations = await connectorObservations(
      scope.db,
      scope.tenant_id,
      rows.map((row) => row.id),
    );
    const credentialStates = await describeConnectorCredentialStates(
      scope.tenant_id,
      rows,
      scope.db,
    );
    const counts = await connectorCategoryCounts(scope.tenant_id, scope.db);
    const categories = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort(compareCategoryCounts);
    return { rows, total, observations, credentialStates, categories };
  },
  http: {
    method: "get",
    path: "/v1/connectors",
    tags: ["connectors"],
    query: ListConnectorsQuery,
    response: ConnectorListResponse,
    toInput: ({ query }) => ({ options: listOptionsFromQuery(query as ListQuery), catalog: true }),
    toBody: ({ rows, total, observations, credentialStates, categories }) => ({
      items: rows.map((r) => ({
        ...serialize(r),
        ...observations.get(r.id),
        credential: credentialStates.get(r.id) ?? null,
      })),
      total,
      categories,
    }),
  },
  tool: {
    name: "list_connectors",
    description:
      "List the tenant's connectors with what each one is for (`description`) and the catalog block it belongs to (`category`). `category` and `driver` are filters.",
    use_case:
      "Call early to find out which external systems the tenant has already configured; use the resulting slugs in placeholder tokens when authoring steps.",
    important_notes: [
      "Returns metadata only (id, slug, description, category, driver, environment). Call get_connector for placeholder tokens and config.",
      `No credentials are returned here — use \${cred.<slug>.<field>} tokens, never inline values.`,
    ],
    input: ListConnectorsToolInput,
    gate: "enforced",
    toInput: (raw) => {
      const args = raw as ListToolArgs;
      return {
        options: {
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.driver !== undefined ? { driver: args.driver } : {}),
        },
        catalog: false,
      };
    },
    toResult: (outcome) => {
      if (isRejection(outcome)) return { ok: false, data: { error: outcome.code } };
      const { rows, total } = outcome;
      return {
        ok: true,
        data: {
          items: rows.map((c) => ({
            id: c.id,
            display_name: c.display_name,
            slug: c.slug,
            description: listedDescription(c.description),
            driver: c.driver,
            category: c.category,
            environment: c.environment,
            needs_reauth: c.needs_reauth,
            auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
          })),
          total,
          returned: rows.length,
          offset: 0,
          has_more: rows.length < total,
        },
      };
    },
  },
});

export const createConnectorOperation = defineOperation<CreateConnectorInput, ConnectorView>({
  id: "connector.create",
  summary: "Create a connector",
  permission: "connector:write",
  effect: "write",
  audit: AuditAction.CONNECTOR_CREATED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const outcome = await createConnectorOutcome(
      {
        tenant_id: scope.tenant_id,
        input,
        actor_id: principal.id,
        actor: actorOf(principal),
      },
      scope.db,
    );
    if (!outcome.ok) return connectorWriteRejection(outcome.rejection);
    const created = outcome.value;
    await warmGraphqlSchema(scope.db, scope.tenant_id, principal.kind, principal.id, created);
    return created;
  },
  http: {
    method: "post",
    path: "/v1/connectors",
    tags: ["connectors"],
    body: CreateConnectorSchema,
    response: ConnectorSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request" },
    toInput: ({ json }) => json as CreateConnectorInput,
    toBody: (created) => serialize(created),
  },
});

type ConnectorGetView = "http" | "tool";

interface ConnectorGetInput {
  readonly id: string;
  readonly view: ConnectorGetView;
}

interface ConnectorGetResult {
  readonly connector: ConnectorView;
  readonly credentials?: unknown[];
  readonly observation?: Observation | undefined;
  readonly credential?: CredentialState | null;
  readonly placeholders?: Placeholders;
}

async function connectorDetail(
  scope: OperationScope,
  found: ConnectorView,
): Promise<ConnectorGetResult> {
  const rows = await listConnectorCredentials(scope.tenant_id, found.id, scope.db);
  const connections = await summarizeConnections(
    scope.db,
    scope.tenant_id,
    rows.flatMap((row) => (row.connection_id ? [row.connection_id] : [])),
  );
  const credentials = rows.map(({ connection_id, ...row }) => ({
    ...row,
    connection: connection_id ? (connections.get(connection_id) ?? null) : null,
  }));
  const observations = await connectorObservations(scope.db, scope.tenant_id, [found.id]);
  const credentialStates = await describeConnectorCredentialStates(
    scope.tenant_id,
    [found],
    scope.db,
  );
  return {
    connector: found,
    credentials,
    observation: observations.get(found.id),
    credential: credentialStates.get(found.id) ?? null,
  };
}

export const getConnectorOperation = defineOperation<ConnectorGetInput, ConnectorGetResult>({
  id: "connector.get",
  summary: "Fetch a connector",
  permission: "connector:read",
  resource: { type: "connector", param: "id" },
  effect: "read",
  async handler(scope, { id, view }) {
    const found = await getConnector(scope.tenant_id, id, scope.db);
    if (!found) return reject.notFound("connector");
    if (view === "http") return connectorDetail(scope, found);
    const placeholders = await describeConnectorPlaceholders(found.slug, {
      tenant_id: scope.tenant_id,
      environment: found.environment as "dev" | "prod",
      db: scope.db,
    });
    return { connector: found, placeholders };
  },
  http: {
    method: "get",
    path: "/v1/connectors/{id}",
    tags: ["connectors"],
    params: IdParam,
    response: ConnectorSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id, view: "http" }),
    toBody: ({ connector, observation, credentials, credential }) => ({
      ...serialize(connector),
      ...observation,
      credentials,
      credential,
    }),
  },
  tool: {
    name: "get_connector",
    description:
      "Fetch a single connector by id, plus the placeholder tokens to use in workflow steps.",
    use_case: `Call before authoring a step that hits this connector — the returned \`placeholders\` field tells you exactly which \${cred.<slug>.<field>} and \${connector.<slug>.*} tokens are wired up in this environment.`,
    important_notes: [
      "`placeholders.credentials` is empty when no credential is configured; create one before writing a step that expects it.",
      "`placeholders` reflects the connector's active environment only — a dev connector does not expose prod tokens.",
      "Issues a `connector:read` RBAC check; low-privilege principals get `permission_denied` instead of the config.",
      "Secrets in `config` and the password inside `dsn` read as `***redacted***`. Send that value back unchanged in update_connector to keep the stored secret.",
    ],
    input: GetConnectorToolInput,
    gate: "enforced",
    toInput: (raw) => ({ id: (raw as GetToolArgs).id, view: "tool" }),
    toResult: (outcome) => {
      if (isRejection(outcome)) return { ok: false, data: { error: "connector_not_found" } };
      const c = outcome.connector;
      return {
        ok: true,
        data: {
          connector: {
            ...toPublicConnector(c),
            needs_reauth: c.needs_reauth,
            auth_failed_at: c.auth_failed_at?.toISOString() ?? null,
          },
          placeholders: outcome.placeholders,
        },
      };
    },
  },
});

interface ConnectorUpdateInput {
  readonly id: string;
  readonly patch: UpdateConnectorInput;
}

export const updateConnectorOperation = defineOperation<ConnectorUpdateInput, ConnectorView>({
  id: "connector.update",
  summary: "Update a connector",
  permission: "connector:write",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_UPDATED,
  async handler(scope, { id, patch }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const outcome = await updateConnectorOutcome(
      scope.tenant_id,
      id,
      patch,
      actorOf(principal),
      scope.db,
    );
    if (!outcome.ok) return connectorWriteRejection(outcome.rejection);
    return outcome.value ?? reject.notFound("connector");
  },
  http: {
    method: "patch",
    path: "/v1/connectors/{id}",
    tags: ["connectors"],
    params: IdParam,
    body: UpdateConnectorSchema,
    response: ConnectorSchema,
    errors: {
      400: "Invalid description acceptance",
      404: "Not found",
      409: "The reviewed description changed, or clear_template_binding was combined with template_slug",
    },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      patch: json as UpdateConnectorInput,
    }),
    toBody: (updated) => serialize(updated),
  },
});

function enablementOperation(segment: "enable" | "disable") {
  const enabled = segment === "enable";
  return defineOperation<string, ConnectorView>({
    id: `connector.${segment}`,
    summary: `${enabled ? "Enable" : "Disable"} a connector`,
    permission: "connector:write",
    resource: { type: "connector", param: "id" },
    effect: "write",
    audit: AuditAction.CONNECTOR_UPDATED,
    async handler(scope, id) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const updated = await setConnectorEnabled(
        scope.tenant_id,
        id,
        enabled,
        actorOf(principal),
        scope.db,
      );
      return updated ?? reject.notFound("connector");
    },
    http: {
      method: "post",
      path: `/v1/connectors/{id}/${segment}`,
      tags: ["connectors"],
      params: IdParam,
      response: ConnectorSchema,
      errors: { 404: "Not found" },
      toInput: ({ param }) => (param as { id: string }).id,
      toBody: (updated) => serialize(updated),
    },
  });
}

export const enableConnectorOperation = enablementOperation("enable");

export const disableConnectorOperation = enablementOperation("disable");

export const deleteConnectorOperation = defineOperation<string, true>({
  id: "connector.delete",
  summary: "Delete a connector",
  permission: "connector:delete",
  resource: { type: "connector", param: "id" },
  effect: "write",
  audit: AuditAction.CONNECTOR_DELETED,
  async handler(scope, id) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const ok = await deleteConnector(scope.tenant_id, id, actorOf(principal), scope.db);
    return ok ? true : reject.notFound("connector");
  },
  http: {
    method: "delete",
    path: "/v1/connectors/{id}",
    tags: ["connectors"],
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => (param as { id: string }).id,
    toBody: () => null,
  },
});
