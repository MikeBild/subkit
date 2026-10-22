import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { browserSessionDenyReason } from "../auth/browser-session.ts";
import { productSubjectDigest } from "../auth/identity-link.ts";
import { clientLivenessRefusal } from "../auth/liveness.ts";
import { resolvePrincipalFromApiKeyRow } from "../auth/providers/api-key-row.ts";
import { isCeilingScope, isMcpModeMarkerScope } from "../auth/scopes.ts";
import type { AllowList, ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import {
  apiKeys,
  mcpOauthAccessTokens,
  mcpOauthClients,
  productIdentityTombstones,
  roles,
  sessions,
  systemAccounts,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { sha256Hex } from "../identity/api-key.ts";
import { type CallerContext, CallerContextSchema } from "./caller-context.ts";

import {
  matchingWorkflowPermission,
  type WorkflowPermission,
  WorkflowPermissionSchema,
} from "./workflow-permission.ts";

const SourceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("api_key"), api_key_id: z.uuid(), credential_version: z.string() })
    .strict(),
  z.object({ kind: z.literal("browser_session"), session_id: z.uuid() }).strict(),
  z
    .object({ kind: z.literal("mcp_oauth"), access_token_id: z.uuid(), client_id: z.string() })
    .strict(),
  z
    .object({
      kind: z.literal("token_exchange"),
      api_key_id: z.uuid(),
      credential_version: z.string(),
      expires_at: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_bearer"),
      provider_id: z.string().min(1),
      identity_id: z.uuid(),
      issued_at: z.iso.datetime(),
      expires_at: z.iso.datetime(),
    })
    .strict(),
]);

const AllowListSchema = z.union([z.array(z.string()), z.literal("all")]);

export const ExecutionAuthorizationContextSchema = z
  .object({
    source: SourceSchema,
    workflow_permission: WorkflowPermissionSchema.optional(),
    scopes: z.array(z.string()).optional(),
    allowed_workflows: AllowListSchema.optional(),
    allowed_connectors: AllowListSchema.optional(),
  })
  .strict();

export type ExecutionAuthorizationContext = z.infer<typeof ExecutionAuthorizationContextSchema>;

export function authorizationContextFromPrincipal(
  principal: ResolvedPrincipal | null | undefined,
  workflowPermission?: WorkflowPermission | null,
  workflowId?: string | null,
): ExecutionAuthorizationContext | null {
  if (!principal?.auth_source) return null;
  const proof = matchingWorkflowPermission(
    workflowPermission,
    {
      tenantId: principal.tenant_id,
      principalId: principal.id,
      principalKind: principal.kind,
      provider: principal.provider,
      productId: principal.product_id ?? null,
    },
    workflowId,
  );
  return ExecutionAuthorizationContextSchema.parse({
    ...(proof ? { workflow_permission: proof } : {}),
    source: principal.auth_source,
    ...(principal.scopes !== undefined ? { scopes: principal.scopes } : {}),
    ...(principal.allowed_workflows !== undefined
      ? { allowed_workflows: principal.allowed_workflows }
      : {}),
    ...(principal.allowed_connectors !== undefined
      ? { allowed_connectors: principal.allowed_connectors }
      : {}),
  });
}

function refuse(): never {
  throw Object.assign(
    new Error("The queued execution authentication is unavailable or no longer valid."),
    {
      code: "execution_authentication_unavailable",
    },
  );
}

export function intersectExecutionAllowLists(
  captured: AllowList | undefined,
  current: AllowList | undefined,
): AllowList | undefined {
  if (captured === undefined || captured === "all") return current;
  if (current === undefined || current === "all") return captured;
  return captured.filter((entry) => current.includes(entry));
}

export function intersectExecutionScopes(
  captured: string[] | undefined,
  current: string[] | undefined,
): string[] | undefined {
  if (captured === undefined) return current;
  if (current === undefined) return captured;
  const originalCeiling = captured.filter(isCeilingScope);
  const currentCeiling = current.filter(isCeilingScope);
  const originalBroad = captured.includes("*") || originalCeiling.length === 0;
  const currentBroad = current.includes("*") || currentCeiling.length === 0;
  const ceiling = originalBroad
    ? currentCeiling
    : currentBroad
      ? originalCeiling
      : originalCeiling.filter((scope) => currentCeiling.includes(scope));
  if (!originalBroad && !currentBroad && ceiling.length === 0) refuse();
  const markers = captured.filter(
    (scope) => isMcpModeMarkerScope(scope) && current.includes(scope),
  );
  return [
    ...new Set([
      ...ceiling,
      ...markers,
      ...(originalBroad && currentBroad && captured.includes("*") && current.includes("*")
        ? ["*"]
        : []),
    ]),
  ];
}

async function currentIdentity(db: Db, caller: CallerContext): Promise<ResolvedPrincipal> {
  const person =
    caller.principalKind === "user"
      ? (
          await db
            .select({
              role: roles.name,
              deleted: users.deleted_at,
              status: users.status,
              email: users.email,
            })
            .from(users)
            .leftJoin(roles, eq(roles.id, users.role_id))
            .where(and(eq(users.tenant_id, caller.tenantId), eq(users.id, caller.principalId)))
            .limit(1)
        )[0]
      : (
          await db
            .select({ role: roles.name, deleted: systemAccounts.deleted_at })
            .from(systemAccounts)
            .leftJoin(roles, eq(roles.id, systemAccounts.role_id))
            .where(
              and(
                eq(systemAccounts.tenant_id, caller.tenantId),
                eq(systemAccounts.id, caller.principalId),
              ),
            )
            .limit(1)
        )[0];
  if (
    !person?.role ||
    person.deleted !== null ||
    ("status" in person && person.status !== "active")
  )
    refuse();
  return {
    provider: caller.provider,
    kind: caller.principalKind,
    id: caller.principalId,
    tenant_id: caller.tenantId,
    roles: person.role ? [person.role] : [],
    ...("email" in person && typeof person.email === "string" ? { email: person.email } : {}),
  };
}

async function rehydrateExternalBearer(
  db: Db,
  caller: CallerContext,
  source: Extract<ExecutionAuthorizationContext["source"], { kind: "external_bearer" }>,
  identity: ResolvedPrincipal,
): Promise<ResolvedPrincipal> {
  if (
    caller.principalKind !== "user" ||
    caller.provider !== source.provider_id ||
    !caller.productId ||
    !caller.subject
  )
    refuse();
  const [binding] = await db
    .select({
      user_id: userIdentities.user_id,
      provider_id: userIdentities.provider_id,
      product_id: userIdentities.product_id,
      subject: userIdentities.subject,
    })
    .from(userIdentities)
    .where(
      and(eq(userIdentities.tenant_id, caller.tenantId), eq(userIdentities.id, source.identity_id)),
    )
    .limit(1);
  if (
    !binding ||
    binding.user_id !== caller.principalId ||
    binding.provider_id !== source.provider_id ||
    binding.product_id !== caller.productId ||
    binding.subject !== caller.subject
  )
    refuse();
  const [tombstone] = await db
    .select({ erased_at: productIdentityTombstones.erased_at })
    .from(productIdentityTombstones)
    .where(
      and(
        eq(productIdentityTombstones.tenant_id, caller.tenantId),
        eq(productIdentityTombstones.provider_id, source.provider_id),
        eq(productIdentityTombstones.subject_sha256, productSubjectDigest(binding.subject)),
      ),
    )
    .limit(1);
  if (tombstone && new Date(source.issued_at) <= tombstone.erased_at) refuse();
  identity.product_id = binding.product_id;
  identity.subject = binding.subject;
  delete identity.email;
  return identity;
}

export async function rehydrateExecutionPrincipal(
  db: Db,
  rawCaller: unknown,
  rawAuthorization: unknown,
  now = new Date(),
): Promise<ResolvedPrincipal | null> {
  if (!rawCaller) {
    if (rawAuthorization) refuse();
    return null;
  }
  const parsedCaller = CallerContextSchema.safeParse(rawCaller);
  const parsedAuthorization = ExecutionAuthorizationContextSchema.safeParse(rawAuthorization);
  if (!parsedCaller.success || !parsedAuthorization.success) refuse();
  const caller = parsedCaller.data;
  const authorization = parsedAuthorization.data;
  const source = authorization.source;
  const identity = await currentIdentity(db, caller);
  let principal: ResolvedPrincipal;
  if (source.kind === "api_key" || source.kind === "token_exchange") {
    if (source.kind === "token_exchange" && new Date(source.expires_at) <= now) refuse();
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, caller.tenantId), eq(apiKeys.id, source.api_key_id)))
      .limit(1);
    if (!key || sha256Hex(key.token_sha256) !== source.credential_version) refuse();
    const resolved = await resolvePrincipalFromApiKeyRow(db, key, {
      provider: caller.provider,
      ...(source.kind === "token_exchange" ? { via: "token_exchange" as const } : {}),
    });
    if (!resolved) refuse();
    principal = resolved;
    principal.roles = identity.roles;
  } else if (source.kind === "browser_session") {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tenant_id, caller.tenantId), eq(sessions.id, source.session_id)))
      .limit(1);
    if (
      !session ||
      caller.principalKind !== "user" ||
      session.user_id !== caller.principalId ||
      browserSessionDenyReason(session, now)
    )
      refuse();
    principal = identity;
    principal.session_id = session.id;
    if (session.product_id) principal.product_id = session.product_id;
  } else if (source.kind === "external_bearer") {
    principal = await rehydrateExternalBearer(db, caller, source, identity);
  } else {
    const [token] = await db
      .select()
      .from(mcpOauthAccessTokens)
      .where(
        and(
          eq(mcpOauthAccessTokens.tenant_id, caller.tenantId),
          eq(mcpOauthAccessTokens.id, source.access_token_id),
        ),
      )
      .limit(1);
    if (
      !token ||
      caller.principalKind !== "user" ||
      token.user_id !== caller.principalId ||
      token.client_id !== source.client_id ||
      token.revoked_at ||
      token.expires_at <= now
    )
      refuse();
    // tenant-filter:exempt — OAuth clients are global registrations without a tenant column
    const [client] = await db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, source.client_id))
      .limit(1);
    if (clientLivenessRefusal(client)) refuse();
    principal = identity;
    principal.oauth_client_id = token.client_id;
    principal.scopes = token.scope.split(" ").filter(Boolean);
  }
  if (
    principal.id !== caller.principalId ||
    principal.kind !== caller.principalKind ||
    principal.tenant_id !== caller.tenantId ||
    (principal.product_id ?? null) !== caller.productId
  )
    refuse();
  principal.provider = caller.provider;
  principal.auth_source = source;
  const scopes = intersectExecutionScopes(authorization.scopes, principal.scopes);
  const workflows = intersectExecutionAllowLists(
    authorization.allowed_workflows,
    principal.allowed_workflows,
  );
  const connectors = intersectExecutionAllowLists(
    authorization.allowed_connectors,
    principal.allowed_connectors,
  );
  if (scopes !== undefined) principal.scopes = scopes;
  if (workflows !== undefined) principal.allowed_workflows = workflows;
  if (connectors !== undefined) principal.allowed_connectors = connectors;
  return principal;
}
