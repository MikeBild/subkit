import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  browserSessionCookie,
  browserSessionForPrincipal,
  createOidcProvider,
  signBrowserCsrf,
  signBrowserSession,
} from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import {
  browserMembershipIdentity,
  IdentityRecoveryError,
  listMembershipsForIdentity,
  readIdentityRecovery,
  rotateTenantSession,
  SelfServiceIdentityError,
} from "../../../identity/index.ts";
import { ForbiddenError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";

const MembershipSchema = z.object({
  tenant_id: z.string().uuid(),
  slug: z.string(),
  display_name: z.string(),
  origin: z.enum(["self_hosted", "self_service"]),
  user_id: z.string().uuid(),
  role_id: z.string().uuid(),
  role: z.string(),
  is_owner: z.boolean(),
});
const refusal = {
  description: "A verified browser identity session is required",
  content: { "application/json": { schema: ErrorSchema } },
};
const listRoute = createRoute({
  method: "get",
  path: "/v1/identity/memberships",
  tags: ["identity"],
  summary: "List the verified browser identity's active tenant memberships",
  security: [{ browserSession: [] }],
  responses: {
    200: {
      description: "Active memberships",
      content: { "application/json": { schema: z.object({ items: z.array(MembershipSchema) }) } },
    },
    403: refusal,
  },
});
const switchRoute = createRoute({
  method: "post",
  path: "/v1/identity/tenant-session",
  tags: ["identity"],
  summary: "Rotate the verified browser session into an existing tenant membership",
  security: [{ browserSession: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ tenant_id: z.string().uuid() }).strict() },
      },
    },
  },
  responses: {
    200: {
      description: "Rotated tenant session and CSRF proof",
      content: {
        "application/json": {
          schema: z.object({ membership: MembershipSchema, csrf_token: z.string() }),
        },
      },
    },
    403: refusal,
  },
});

const recoveryLoginRoute = createRoute({
  method: "post",
  path: "/v1/identity/recovery/login",
  tags: ["identity"],
  summary: "Reauthenticate a hosted identity for a one-time recovery handoff",
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ provider_id: z.string().min(1) }).strict() },
      },
    },
  },
  responses: {
    200: {
      description: "Fresh interactive OIDC authorization address",
      content: {
        "application/json": { schema: z.object({ authorization_url: z.string().url() }) },
      },
    },
    403: refusal,
  },
});

const recoveryRoute = createRoute({
  method: "get",
  path: "/v1/identity/recovery",
  tags: ["identity"],
  summary: "Read a short-lived verified identity recovery handoff without tenant authority",
  responses: {
    200: {
      description: "Recovery status and one-time action proof",
      content: {
        "application/json": {
          schema: z.object({
            tenant: z
              .object({
                id: z.string().uuid(),
                display_name: z.string(),
                status: z.enum(["active", "suspended", "pending_deletion"]),
                deletion_scheduled_for: z.string().datetime().nullable(),
              })
              .nullable(),
            can_restore: z.boolean(),
            csrf_token: z.string(),
            expires_at: z.string().datetime(),
          }),
        },
      },
    },
    403: refusal,
  },
});

const recoveryProvidersRoute = createRoute({
  method: "get",
  path: "/v1/identity/recovery/providers",
  tags: ["identity"],
  summary: "List public provider choices for verified hosted identity recovery",
  responses: {
    200: {
      description: "Hosted recovery provider labels",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(z.object({ id: z.string(), label: z.string() })) }),
        },
      },
    },
  },
});

export function hostedIdentityProviders() {
  const config = getConfig();
  if (!config.auth.hosted.enabled) return [];
  return config.auth.providers.flatMap((provider) =>
    provider.protocol === "oidc" &&
    provider.signup_policy === "self_service" &&
    !provider.product_id
      ? [provider]
      : [],
  );
}

export function registerMembershipRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(recoveryProvidersRoute, (c) => {
    const items = hostedIdentityProviders().map(({ id, label }) => ({ id, label }));
    c.header("cache-control", "no-store");
    return c.json({ items }, 200);
  });

  app.openapi(recoveryLoginRoute, async (c) => {
    if (c.req.header("sec-fetch-site") === "cross-site")
      throw new ForbiddenError("recovery_login_origin_rejected");
    const origin = c.req.header("origin");
    if (
      origin &&
      origin !== new URL(c.req.url).origin &&
      origin !== new URL(getConfig().server.public_base_url).origin
    )
      throw new ForbiddenError("recovery_login_origin_rejected");
    const provider = hostedIdentityProviders().find(
      (entry) => entry.id === c.req.valid("json").provider_id,
    );
    if (!provider) throw new ForbiddenError("hosted_provider_required");
    const adapter = createOidcProvider({ db: c.get("db"), providerId: provider.id });
    const start = new URL("/v1/identity/login/start", c.req.url);
    start.searchParams.set("redirect_to", "/v1/identity/recovery");
    const response = await adapter.startLogin?.(new Request(start));
    if (response?.status !== 302) throw new ForbiddenError("hosted_provider_unavailable");
    const authorizationUrl = response.headers.get("location");
    if (!authorizationUrl) throw new ForbiddenError("hosted_provider_unavailable");
    for (const cookie of response.headers.getSetCookie())
      c.header("set-cookie", cookie, { append: true });
    c.header("cache-control", "no-store");
    return c.json({ authorization_url: authorizationUrl }, 200);
  });

  app.openapi(recoveryRoute, async (c) => {
    try {
      const state = await readIdentityRecovery(c.req.raw, c.get("db"));
      c.header("cache-control", "no-store");
      return c.json(
        {
          ...state,
          tenant: state.tenant
            ? {
                ...state.tenant,
                deletion_scheduled_for: state.tenant.deletion_scheduled_for?.toISOString() ?? null,
              }
            : null,
          expires_at: state.expires_at.toISOString(),
        },
        200,
      );
    } catch (error) {
      if (error instanceof IdentityRecoveryError) throw new ForbiddenError(error.code);
      throw error;
    }
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const payload = await browserSessionForPrincipal(c.req.raw, principal);
    if (!payload || principal.product_id)
      throw new ForbiddenError("verified_browser_identity_required");
    const db = c.get("db");
    try {
      const proof = await browserMembershipIdentity(payload, db);
      const items = await listMembershipsForIdentity(proof.identity_id, db);
      c.header("cache-control", "no-store");
      return c.json({ items }, 200);
    } catch (error) {
      if (error instanceof SelfServiceIdentityError) throw new ForbiddenError(error.code);
      throw error;
    }
  });
  app.openapi(switchRoute, async (c) => {
    const principal = requireAuth(c);
    const payload = await browserSessionForPrincipal(c.req.raw, principal);
    if (!payload || principal.product_id)
      throw new ForbiddenError("verified_browser_identity_required");
    try {
      const { membership, session } = await rotateTenantSession(
        { ...payload, target_tenant_id: c.req.valid("json").tenant_id },
        c.get("db"),
      );
      const nextPayload = {
        session_id: session.id,
        tenant_id: session.tenant_id,
        user_id: session.user_id,
      };
      const jwt = await signBrowserSession(nextPayload);
      const remaining = Math.max(
        0,
        Math.floor(((session.absolute_expires_at?.getTime() ?? 0) - Date.now()) / 1000),
      );
      c.header("set-cookie", browserSessionCookie(jwt, remaining));
      c.header("cache-control", "no-store");
      return c.json({ membership, csrf_token: await signBrowserCsrf(nextPayload) }, 200);
    } catch (error) {
      if (error instanceof SelfServiceIdentityError) throw new ForbiddenError(error.code);
      throw error;
    }
  });
}
