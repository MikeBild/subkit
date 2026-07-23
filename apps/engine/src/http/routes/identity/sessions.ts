// POST /v1/identity/sessions — exchange a configured provider assertion for
// a personal SubKit API key. The route is protocol-aware and provider-neutral:
// callers identify a configured adapter, never an issuer or vendor mode.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import * as jose from "jose";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import {
  IdentityLinkConflictError,
  type ResolvedPrincipal,
  resolveProviderIdentity,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import type { Config } from "../../../config/schema.ts";
import type { Db } from "../../../db/client.ts";
import { tenants } from "../../../db/schema/index.ts";
import * as identity from "../../../identity/index.ts";
import { type DiscoveryDoc, fetchDiscovery } from "../../../identity/index.ts";
import { logger } from "../../../logging/index.ts";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../../errors.ts";
import type { AppEnv } from "../../openapi.ts";
import { ErrorSchema } from "./schemas.ts";

type ProviderConfig = Config["auth"]["providers"][number];
type OidcConfig = Extract<ProviderConfig, { protocol: "oidc" }>;

const SessionBody = z
  .object({
    provider_id: z.string().min(1),
    identity_token: z.string().min(1),
  })
  .strict()
  .openapi("IdentitySessionRequest");

const SessionResponse = z
  .object({
    api_key: z.string(),
    principal_id: z.string(),
    context_id: z.string().nullable(),
    email: z.string().nullable(),
  })
  .strict()
  .openapi("IdentitySessionResponse");

const route = createRoute({
  method: "post",
  path: "/v1/identity/sessions",
  operationId: "createIdentitySession",
  tags: ["MCP authentication"],
  summary: "Exchange a configured identity assertion for a scoped API key",
  request: {
    body: { required: true, content: { "application/json": { schema: SessionBody } } },
  },
  responses: {
    200: {
      description: "Scoped product session",
      content: { "application/json": { schema: SessionResponse } },
    },
    400: {
      description: "Unsupported provider protocol or malformed request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Invalid identity assertion",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Provider not configured or identity is not allowed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

async function tenantId(db: Db, slug: string): Promise<string> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new BadRequestError("configured tenant not provisioned");
  return id;
}

async function resolveOidcAssertion(
  db: Db,
  provider: OidcConfig,
  identityToken: string,
): Promise<{
  principal: ResolvedPrincipal;
  subject: string;
  issuer: string;
  email: string | null;
}> {
  let discovery: DiscoveryDoc;
  try {
    discovery = await fetchDiscovery(new URL(provider.issuer_url));
  } catch (error) {
    logger.warn({
      module: "auth",
      action: "oidc.discovery_failed",
      msg: "configured identity discovery failed",
      provider_id: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new BadRequestError("identity discovery failed");
  }
  if (!discovery.jwks_uri) throw new BadRequestError("issuer metadata missing jwks_uri");

  let claims: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(
      identityToken,
      jose.createRemoteJWKSet(new URL(discovery.jwks_uri)),
      { issuer: discovery.issuer, audience: provider.client_id },
    );
    claims = result.payload;
  } catch (error) {
    logger.warn({
      module: "auth",
      action: "oidc.verify_failed",
      msg: "identity assertion rejected",
      provider_id: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new UnauthorizedError("identity assertion rejected");
  }

  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!subject) throw new UnauthorizedError("identity assertion missing subject");
  const email =
    claims.email_verified === true && typeof claims.email === "string" && claims.email.trim()
      ? claims.email.trim().toLowerCase()
      : null;
  const accountEmail = email ?? `${provider.id}:${subject}@invalid`;
  const resolvedTenantId = await tenantId(db, provider.tenant_slug);

  let resolved: Awaited<ReturnType<typeof resolveProviderIdentity>>;
  try {
    resolved = await resolveProviderIdentity(db, {
      tenantId: resolvedTenantId,
      providerId: provider.id,
      subject,
      email: accountEmail,
      linkByEmail: email !== null,
    });
  } catch (error) {
    if (error instanceof IdentityLinkConflictError) throw new ForbiddenError(error.message);
    throw error;
  }
  const user = resolved.user;
  if (user.deleted_at !== null || user.status !== "active") {
    throw new ForbiddenError("user is not active");
  }
  if (resolved.createdUser || resolved.linkedIdentity) {
    await auditAwait(
      {
        tenant_id: resolvedTenantId,
        actor_type: "system",
        actor_id: null,
        action: resolved.createdUser ? AuditAction.USER_CREATED : AuditAction.USER_IDENTITY_LINKED,
        resource_type: "user",
        resource_id: user.id,
        result: "success",
        metadata: { source: provider.id, subject, email: accountEmail },
      },
      db,
    );
  }
  return {
    principal: {
      provider: provider.id,
      kind: "user",
      id: user.id,
      tenant_id: resolvedTenantId,
      roles: [user.role],
      ...(user.email ? { email: user.email } : {}),
    },
    subject,
    issuer: discovery.issuer,
    email,
  };
}

export function registerIdentitySessionsRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const provider = getConfig().auth.providers.find((entry) => entry.id === body.provider_id);
    if (!provider) throw new ForbiddenError("identity provider not configured");
    if (provider.protocol === "api_key") {
      throw new BadRequestError("api_key does not accept identity assertions");
    }

    const resolved = await resolveOidcAssertion(db, provider, body.identity_token);
    const principal = resolved.principal;
    const issued = await identity.issueApiKey(
      {
        tenant_id: principal.tenant_id,
        owner_kind: "user",
        owner_id: principal.id,
        scopes: ["*"],
        actor_id: principal.id,
      },
      db,
    );
    const metadata = {
      provider_id: provider.id,
      protocol: provider.protocol,
      issuer: resolved.issuer,
      ...(resolved.subject ? { subject: resolved.subject } : {}),
    };

    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.SESSION_ISSUED,
        resource_type: "session",
        resource_id: issued.view.id,
        result: "success",
        metadata,
      },
      db,
    );
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: "user",
        actor_id: principal.id,
        action: AuditAction.USER_LOGGED_IN,
        resource_type: "user",
        resource_id: principal.id,
        result: "success",
        metadata,
      },
      db,
    );

    const userAgent = c.req.header("user-agent") ?? "";
    if (userAgent.startsWith("sk-cli/")) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: "user",
          actor_id: principal.id,
          action: AuditAction.SK_CLI_LOGIN,
          resource_type: "user",
          resource_id: principal.id,
          result: "success",
          metadata: { ...metadata, user_agent: userAgent },
        },
        db,
      );
    }

    return c.json(
      {
        api_key: issued.plaintext,
        principal_id: principal.id,
        context_id: principal.tenant_id,
        email: resolved.email,
      },
      200,
    );
  });
}
