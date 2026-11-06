import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { policy } from "../../auth/policy.ts";
import { enforce } from "../../http/middleware/policy.ts";
import {
  type ApiKeyView,
  createSystemAccount,
  deleteSystemAccount,
  getApiKey,
  issueApiKey,
  issuePortalToken,
  listApiKeys,
  listPortalTokens,
  listSystemAccounts,
  type PortalTokenView,
  revokeApiKey,
  revokePortalToken,
  rotateApiKey,
} from "../../identity/service.ts";
import { IdParam, PaginationQuery, paginatedResponse } from "../common-schemas.ts";
import {
  ApiKeyIssuedSchema,
  ApiKeySchema,
  PortalTokenIssuedSchema,
  PortalTokenSchema,
  SystemAccountSchema,
  serializeApiKey,
  serializePortalToken,
  serializeSystemAccount,
} from "./identity-representation.ts";
import { defineOperation, reject } from "./index.ts";

const TAGS = ["identity"] as const;
const UNAUTHORIZED = "Unauthorized";
const FORBIDDEN = "Forbidden";

interface IdInput {
  readonly id: string;
}

const idInput = ({ param }: { param: unknown }): IdInput => ({ id: (param as IdInput).id });

const SystemAccountListResponse = z
  .object({ items: z.array(SystemAccountSchema) })
  .openapi("SystemAccountListResponse");

const CreateSystemAccountBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
  })
  .openapi("CreateSystemAccountBody");

type SystemAccountRow = Awaited<ReturnType<typeof createSystemAccount>>;
type PageInput = z.infer<typeof PaginationQuery>;
type CreateSystemAccountInput = z.infer<typeof CreateSystemAccountBody>;

export const listSystemAccountsOperation = defineOperation<PageInput, SystemAccountRow[]>({
  id: "identity.system_account.list",
  summary: "List system accounts",
  permission: "identity:read",
  effect: "read",
  async handler(scope, q) {
    if (!scope.principal) return reject.unauthorized();
    enforce(
      scope.principal,
      policy.adminOnly(scope.principal),
      { resource_type: "system_account" },
      scope.db,
    );
    return listSystemAccounts(
      scope.tenant_id,
      {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      scope.db,
    );
  },
  http: {
    method: "get",
    path: "/v1/identity/system-accounts",
    tags: TAGS,
    query: PaginationQuery,
    response: SystemAccountListResponse,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: ({ query }) => query as PageInput,
    toBody: (items) => ({ items: items.map(serializeSystemAccount) }),
  },
});

export const createSystemAccountOperation = defineOperation<
  CreateSystemAccountInput,
  SystemAccountRow
>({
  id: "identity.system_account.create",
  summary: "Create a system account",
  permission: "identity:write",
  effect: "write",
  audit: AuditAction.SYSTEM_ACCOUNT_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(principal, policy.adminOnly(principal), { resource_type: "system_account" }, scope.db);
    return createSystemAccount(
      {
        tenant_id: scope.tenant_id,
        name: body.name,
        description: body.description ?? null,
        actor_kind: principal.kind,
        actor_id: principal.id,
      },
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/identity/system-accounts",
    tags: TAGS,
    body: CreateSystemAccountBody,
    response: SystemAccountSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request", 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: ({ json }) => json as CreateSystemAccountInput,
    toBody: serializeSystemAccount,
  },
});

export const deleteSystemAccountOperation = defineOperation<IdInput, true>({
  id: "identity.system_account.delete",
  summary: "Delete a system account",
  permission: "identity:write",
  resource: { type: "system_account", param: "id" },
  effect: "write",
  audit: AuditAction.SYSTEM_ACCOUNT_DELETED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(principal, policy.adminOnly(principal), { resource_type: "system_account" }, scope.db);
    const row = await deleteSystemAccount(
      { tenant_id: scope.tenant_id, id, actor_kind: principal.kind, actor_id: principal.id },
      scope.db,
    );
    if (!row) return reject.notFound("system_account");
    return true;
  },
  http: {
    method: "delete",
    path: "/v1/identity/system-accounts/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN, 404: "Not found" },
    toInput: idInput,
    toBody: () => null,
  },
});

const ApiKeyListResponse = paginatedResponse(ApiKeySchema, "ApiKeyListResponse");

const IssueApiKeyBody = z
  .object({
    owner_kind: z.enum(["user", "system_account"]),
    owner_id: z.string().uuid(),
    name: z
      .string()
      .optional()
      .describe(
        'Operator-facing label, e.g. "claude-code". Useful when running one key per channel — a read-and-execute key for a browser client, an mcp:authoring key for a coding agent.',
      ),
    scopes: z
      .array(z.string().min(1))
      .max(64)
      .optional()
      .describe(
        "Permission names from GET /v1/rbac/permissions, '*', or mcp:read, mcp:authoring, mcp:admin. Each must be held by the issuing credential; '*' only from a credential without scope limits. Omitted: the issuer's own ceiling.",
      ),
    allowed_workflows: z.array(z.string()).optional(),
    allowed_connectors: z.array(z.string()).optional(),
    expires_at: z.string().datetime().optional(),
  })
  .openapi("IssueApiKeyBody");

const RotateApiKeyBody = z
  .object({
    overlap_minutes: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60)
      .optional(),
  })
  .openapi("RotateApiKeyBody");

const RotateApiKeyResponse = z
  .object({
    old: ApiKeySchema,
    new: ApiKeyIssuedSchema,
  })
  .openapi("RotateApiKeyResponse");

type IssueApiKeyInput = z.infer<typeof IssueApiKeyBody>;
type RotateApiKeyInput = IdInput & { readonly body: z.infer<typeof RotateApiKeyBody> };
type IssuedApiKey = Awaited<ReturnType<typeof issueApiKey>>;
type RotatedApiKey = NonNullable<Awaited<ReturnType<typeof rotateApiKey>>>;

export const listApiKeysOperation = defineOperation<null, ApiKeyView[]>({
  id: "identity.api_key.list",
  summary: "List API keys",
  permission: "api_key:read",
  effect: "read",
  async handler(scope) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(principal, policy.adminReadOnly(principal), { resource_type: "api_key" }, scope.db);
    const items = await listApiKeys(scope.tenant_id, scope.db);
    return principal.roles.includes("admin")
      ? items
      : items.filter((k) => principal.kind === "user" && k.user_id === principal.id);
  },
  http: {
    method: "get",
    path: "/v1/identity/api-keys",
    tags: TAGS,
    response: ApiKeyListResponse,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: () => null,
    toBody: (items) => ({ items: items.map(serializeApiKey) }),
  },
});

export const issueApiKeyOperation = defineOperation<IssueApiKeyInput, IssuedApiKey>({
  id: "identity.api_key.issue",
  summary: "Issue an API key",
  permission: "api_key:write",
  effect: "write",
  audit: AuditAction.API_KEY_ISSUED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const selfMatch =
      body.owner_kind === "user" && principal.kind === "user" && body.owner_id === principal.id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      { resource_type: "api_key", action: "issue" },
      scope.db,
    );
    const expiresAt = body.expires_at ? new Date(body.expires_at) : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return reject.badRequest("expires_at is not a valid timestamp");
    }
    return issueApiKey(
      {
        issuer: { kind: "principal", principal },
        tenant_id: scope.tenant_id,
        owner_kind: body.owner_kind,
        owner_id: body.owner_id,
        ...(body.name ? { name: body.name } : {}),
        ...(body.scopes ? { scopes: body.scopes } : {}),
        ...(body.allowed_workflows ? { allowed_workflows: body.allowed_workflows } : {}),
        ...(body.allowed_connectors ? { allowed_connectors: body.allowed_connectors } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        actor: { kind: principal.kind, id: principal.id },
      },
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/identity/api-keys",
    tags: TAGS,
    body: IssueApiKeyBody,
    response: ApiKeyIssuedSchema,
    success: { status: 201, description: "Created" },
    errors: {
      400: "Bad request",
      401: UNAUTHORIZED,
      403: "Forbidden, or scope_exceeds_issuer when a requested scope is not held by you",
      404: "The owner is not a user or system account of your workspace",
      422: "unknown_scope: a requested scope is not a permission name",
    },
    toInput: ({ json }) => json as IssueApiKeyInput,
    toBody: (result) => ({ ...serializeApiKey(result.view), plaintext_key: result.plaintext }),
  },
});

export const rotateApiKeyOperation = defineOperation<RotateApiKeyInput, RotatedApiKey>({
  id: "identity.api_key.rotate",
  summary: "Rotate an API key",
  permission: "api_key:rotate",
  resource: { type: "api_key", param: "id" },
  effect: "write",
  audit: AuditAction.API_KEY_ROTATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const existing = await getApiKey(scope.tenant_id, id, scope.db);
    if (!existing) return reject.notFound("api_key");
    const selfMatch = principal.kind === "user" && existing.user_id === principal.id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      { resource_type: "api_key", resource_id: id, action: "rotate" },
      scope.db,
    );
    const result = await rotateApiKey(
      {
        issuer: { kind: "principal", principal },
        tenant_id: scope.tenant_id,
        id,
        ...(body.overlap_minutes !== undefined ? { overlap_minutes: body.overlap_minutes } : {}),
        actor: { kind: principal.kind, id: principal.id },
      },
      scope.db,
    );
    if (!result) return reject.notFound("api_key");
    return result;
  },
  http: {
    method: "post",
    path: "/v1/identity/api-keys/{id}/rotate",
    tags: TAGS,
    params: IdParam,
    body: RotateApiKeyBody,
    response: RotateApiKeyResponse,
    success: { status: 200, description: "Rotated" },
    errors: {
      401: UNAUTHORIZED,
      403: "Forbidden, or scope_exceeds_issuer when the key carries scopes your credential does not hold",
      404: "The key, or its owner in your workspace, was not found",
    },
    toInput: ({ param, json }) => ({
      id: (param as IdInput).id,
      body: json as z.infer<typeof RotateApiKeyBody>,
    }),
    toBody: (result) => ({
      old: serializeApiKey(result.old),
      new: { ...serializeApiKey(result.new), plaintext_key: result.plaintext },
    }),
  },
});

export const revokeApiKeyOperation = defineOperation<IdInput, true>({
  id: "identity.api_key.revoke",
  summary: "Revoke an API key",
  permission: "api_key:revoke",
  resource: { type: "api_key", param: "id" },
  effect: "write",
  audit: AuditAction.API_KEY_REVOKED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const existing = await getApiKey(scope.tenant_id, id, scope.db);
    if (!existing) return reject.notFound("api_key");
    const selfMatch = principal.kind === "user" && existing.user_id === principal.id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      { resource_type: "api_key", resource_id: id, action: "revoke" },
      scope.db,
    );
    const row = await revokeApiKey(
      { tenant_id: scope.tenant_id, id, actor_kind: principal.kind, actor_id: principal.id },
      scope.db,
    );
    if (!row) return reject.notFound("api_key");
    return true;
  },
  http: {
    method: "delete",
    path: "/v1/identity/api-keys/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Revoked" },
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN, 404: "Not found" },
    toInput: idInput,
    toBody: () => null,
  },
});

const PortalTokenListResponse = z
  .object({ items: z.array(PortalTokenSchema) })
  .openapi("PortalTokenListResponse");

const IssuePortalTokenBody = z
  .object({
    user_id: z.string().min(1),
    allowed_workflows: z.array(z.string()).min(1),
    ttl_minutes: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60)
      .optional(),
  })
  .openapi("IssuePortalTokenBody");

type IssuePortalTokenInput = z.infer<typeof IssuePortalTokenBody>;
type IssuedPortalToken = Awaited<ReturnType<typeof issuePortalToken>>;

export const listPortalTokensOperation = defineOperation<null, PortalTokenView[]>({
  id: "identity.portal_token.list",
  summary: "List portal tokens",
  permission: "portal_token:read",
  effect: "read",
  async handler(scope) {
    if (!scope.principal) return reject.unauthorized();
    enforce(
      scope.principal,
      policy.adminOnly(scope.principal),
      { resource_type: "portal_token" },
      scope.db,
    );
    return listPortalTokens(scope.tenant_id, scope.db);
  },
  http: {
    method: "get",
    path: "/v1/identity/portal-tokens",
    tags: TAGS,
    response: PortalTokenListResponse,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: () => null,
    toBody: (items) => ({ items: items.map(serializePortalToken) }),
  },
});

export const issuePortalTokenOperation = defineOperation<IssuePortalTokenInput, IssuedPortalToken>({
  id: "identity.portal_token.issue",
  summary: "Issue a portal token",
  permission: "portal_token:write",
  effect: "write",
  audit: AuditAction.PORTAL_TOKEN_ISSUED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(principal, policy.adminOnly(principal), { resource_type: "portal_token" }, scope.db);
    return issuePortalToken(
      {
        tenant_id: scope.tenant_id,
        user_id: body.user_id,
        allowed_workflows: body.allowed_workflows,
        ...(body.ttl_minutes !== undefined ? { ttl_minutes: body.ttl_minutes } : {}),
        actor_kind: principal.kind,
        actor_id: principal.id,
      },
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/identity/portal-tokens",
    tags: TAGS,
    body: IssuePortalTokenBody,
    response: PortalTokenIssuedSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request", 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: ({ json }) => json as IssuePortalTokenInput,
    toBody: (result) => ({
      ...serializePortalToken(result.view),
      plaintext_token: result.plaintext,
    }),
  },
});

export const revokePortalTokenOperation = defineOperation<IdInput, true>({
  id: "identity.portal_token.revoke",
  summary: "Revoke a portal token",
  permission: "portal_token:revoke",
  resource: { type: "portal_token", param: "id" },
  effect: "write",
  audit: AuditAction.PORTAL_TOKEN_REVOKED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(principal, policy.adminOnly(principal), { resource_type: "portal_token" }, scope.db);
    const row = await revokePortalToken(
      { tenant_id: scope.tenant_id, id, actor_kind: principal.kind, actor_id: principal.id },
      scope.db,
    );
    if (!row) return reject.notFound("portal_token");
    return true;
  },
  http: {
    method: "delete",
    path: "/v1/identity/portal-tokens/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Revoked" },
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN, 404: "Not found" },
    toInput: idInput,
    toBody: () => null,
  },
});
