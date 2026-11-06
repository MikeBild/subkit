import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { discoverService } from "../../credentials/connections/discovery.ts";
import { permissionScopes } from "../../credentials/connections/scopes.ts";
import {
  disconnectConnection,
  getConnection,
  listConnections,
  startConnection,
} from "../../credentials/connections/service.ts";
import {
  ConnectionError,
  type ConnectionView,
  type DiscoveryResult,
  ServicePackageSchema,
} from "../../credentials/connections/types.ts";
import {
  buildConnectionCallbackUri,
  resolvePublicOrigin,
} from "../../credentials/oauth2/redirect-uri.ts";
import { IdParam } from "../common-schemas.ts";
import { ConnectionStateEnum, ConnectionStateReasonEnum } from "../connection-schemas.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const ConnectionUserSchema = z
  .object({
    connector_id: z.string(),
    slug: z.string(),
    display_name: z.string(),
    workflow_count: z.number().int().nonnegative(),
  })
  .openapi("ConnectionUser");

const ConnectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    base_url: z.string(),
    issuer: z.string(),
    service_name: z.string().nullable(),
    service_description: z.string().nullable(),
    scopes: z.array(z.string()),
    granted_scopes: z.array(z.string()).nullable(),
    state: ConnectionStateEnum,
    state_reason: ConnectionStateReasonEnum.nullable(),
    auto_renew: z.boolean(),
    expires_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    last_refreshed_at: z.string().nullable(),
    refresh_failed_at: z.string().nullable(),
    last_error: z.string().nullable(),
    used_by: z.array(ConnectionUserSchema),
    created_at: z.string(),
  })
  .openapi("Connection");

const ConnectionListResponse = z
  .object({ items: z.array(ConnectionSchema) })
  .openapi("ConnectionListResponse");

const DiscoverBody = z
  .object({ base_url: z.string().min(1).max(2048) })
  .openapi("ConnectionDiscoverBody");

const DiscoverResponse = z
  .object({
    base_url: z.string(),
    connectable: z.boolean(),
    reason: z.string().nullable(),
    service_name: z.string().nullable(),
    service_description: z.string().nullable(),
    service_version: z.string().nullable(),
    package_url: z.string().nullable(),
    package: ServicePackageSchema.nullable(),
    issuer: z.string().nullable(),
    scopes_supported: z.array(z.string()),
  })
  .openapi("ConnectionDiscoverResponse");

const StartBody = z
  .object({
    name: z.string().min(1).max(63),
    base_url: z.string().min(1).max(2048),
    scopes: z.array(z.string().min(1)).min(1).max(50),
  })
  .openapi("ConnectionStartBody");

const StartResponse = z
  .object({ authorization_url: z.string(), name: z.string() })
  .openapi("ConnectionStartResponse");

const TAGS = ["connections"];
const RESOLVE_ORIGIN_MESSAGE =
  "engine has no resolvable public origin — set server.public_base_url";

type StartBodyInput = z.infer<typeof StartBody>;

interface IdInput {
  readonly id: string;
}

interface Started {
  readonly authorization_url: string;
  readonly name: string;
}

function rejectionOf(error: unknown): Rejection {
  if (error instanceof ConnectionError) {
    if (error.code === "not_found") return reject.notFound("connection");
    if (error.code === "name_taken") return reject.conflict(error.message);
    return reject.badRequest(`${error.code}: ${error.message}`);
  }
  throw error;
}

function originHints(scope: OperationScope): { req?: Request } {
  return scope.request ? { req: scope.request } : {};
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

function startedView(started: Started): Started {
  return { authorization_url: started.authorization_url, name: started.name };
}

function discoveryReason(result: DiscoveryResult): string | null {
  const metadata = result.authorization;
  if (!metadata) return "discovery_missing";
  if (!metadata.registration_endpoint) return "registration_missing";
  if (
    metadata.code_challenge_methods_supported &&
    !metadata.code_challenge_methods_supported.includes("S256")
  )
    return "pkce_unsupported";
  return null;
}

function discoveryView(result: DiscoveryResult) {
  const metadata = result.authorization;
  const reason = discoveryReason(result);
  return {
    base_url: result.base_url,
    connectable: reason === null,
    reason,
    service_name: result.descriptor?.name ?? null,
    service_description: result.descriptor?.description ?? null,
    service_version: result.descriptor?.version ?? null,
    package_url: result.descriptor?.package_url ?? null,
    package: result.package,
    issuer: metadata?.issuer ?? null,
    scopes_supported: permissionScopes(metadata?.scopes_supported ?? []),
  };
}

async function beginAuthorization(
  scope: OperationScope,
  target: StartBodyInput,
  connection_id?: string,
): Promise<Started | Rejection> {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  const redirect_uri = buildConnectionCallbackUri(originHints(scope));
  if (!redirect_uri) return reject.badRequest(RESOLVE_ORIGIN_MESSAGE);
  try {
    return await startConnection(scope.db, {
      tenant_id: scope.tenant_id,
      actor: actorOf(principal),
      owner_user_id: principal.kind === "user" ? principal.id : null,
      name: target.name,
      base_url: target.base_url,
      scopes: target.scopes,
      redirect_uri,
      client_uri: resolvePublicOrigin(originHints(scope)),
      ...(connection_id ? { connection_id } : {}),
    });
  } catch (error) {
    return rejectionOf(error);
  }
}

export const discoverConnectionOperation = defineOperation<{ base_url: string }, DiscoveryResult>({
  id: "connection.discover",
  summary: "Read what a server publishes about itself before connecting",
  permission: "connection:write",
  effect: "read",
  async handler(scope, { base_url }) {
    try {
      return await discoverService(base_url, { tenant_id: scope.tenant_id, exec: scope.db });
    } catch (error) {
      return rejectionOf(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/connections/discover",
    tags: TAGS,
    body: DiscoverBody,
    response: DiscoverResponse,
    errors: { 400: "Bad request" },
    toInput: ({ json }) => ({ base_url: (json as { base_url: string }).base_url }),
    toBody: discoveryView,
  },
});

export const startConnectionOperation = defineOperation<StartBodyInput, Started>({
  id: "connection.start",
  summary: "Register at the server and begin Authorization Code with PKCE",
  permission: "connection:write",
  effect: "write",
  audit: AuditAction.CONNECTION_CREATED,
  handler: (scope, body) => beginAuthorization(scope, body),
  http: {
    method: "post",
    path: "/v1/connections/start",
    tags: TAGS,
    body: StartBody,
    response: StartResponse,
    errors: { 400: "Bad request", 409: "Name taken" },
    toInput: ({ json }) => json as StartBodyInput,
    toBody: startedView,
  },
});

export const listConnectionsOperation = defineOperation<Record<string, never>, ConnectionView[]>({
  id: "connection.list",
  summary: "List outbound connections with their state",
  permission: "connection:read",
  effect: "read",
  handler: (scope) => listConnections(scope.db, scope.tenant_id),
  http: {
    method: "get",
    path: "/v1/connections",
    tags: TAGS,
    response: ConnectionListResponse,
    toInput: () => ({}),
    toBody: (items) => ({ items }),
  },
});

export const getConnectionOperation = defineOperation<IdInput, ConnectionView>({
  id: "connection.get",
  summary: "One outbound connection",
  permission: "connection:read",
  effect: "read",
  async handler(scope, { id }) {
    try {
      return await getConnection(scope.db, scope.tenant_id, id);
    } catch (error) {
      return rejectionOf(error);
    }
  },
  http: {
    method: "get",
    path: "/v1/connections/{id}",
    tags: TAGS,
    params: IdParam,
    response: ConnectionSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (view) => view,
  },
});

export const renewConnectionOperation = defineOperation<IdInput, Started>({
  id: "connection.renew",
  summary: "Repeat the authorization for an existing connection",
  permission: "connection:write",
  effect: "write",
  audit: AuditAction.CONNECTION_RENEWED,
  async handler(scope, { id }) {
    if (!buildConnectionCallbackUri(originHints(scope))) {
      return reject.badRequest(RESOLVE_ORIGIN_MESSAGE);
    }
    let current: ConnectionView;
    try {
      current = await getConnection(scope.db, scope.tenant_id, id);
    } catch (error) {
      return rejectionOf(error);
    }
    return beginAuthorization(
      scope,
      { name: current.name, base_url: current.base_url, scopes: current.scopes },
      id,
    );
  },
  http: {
    method: "post",
    path: "/v1/connections/{id}/renew",
    tags: TAGS,
    params: IdParam,
    response: StartResponse,
    errors: { 400: "Bad request", 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: startedView,
  },
});

export const deleteConnectionOperation = defineOperation<IdInput, null>({
  id: "connection.delete",
  summary: "Disconnect: revoke the stored tokens and forget the connection",
  permission: "connection:write",
  effect: "write",
  audit: AuditAction.CONNECTION_DISCONNECTED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      await disconnectConnection(scope.db, {
        tenant_id: scope.tenant_id,
        id,
        actor_id: principal.id,
        actor: actorOf(principal),
      });
    } catch (error) {
      return rejectionOf(error);
    }
    return null;
  },
  http: {
    method: "delete",
    path: "/v1/connections/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Disconnected" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: () => null,
  },
});
