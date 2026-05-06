// POST /v1/setup — first-run bootstrap redemption endpoint.
//
// Public route (no API key required — there is none yet).  Accepts the
// one-time token printed to engine stdout on first boot plus the four
// operator-supplied values that materialise the engine's first tenant.
// On success: 200 with the new admin api key (the only time it is ever
// returned).  Subsequent calls return 410 Gone.
//
// Surface contract:
//   - Token sits in the request body, NOT the Authorization header,
//     because there is no auth principal yet.  Bearer auth comes online
//     once this route returns the admin key.
//   - The route is open by design; the rate-limit + single-use token +
//     post-bootstrap sentinel together gate it.  Adding it to a "public
//     paths" list isn't necessary because the auth middleware doesn't
//     reject unauthenticated requests — `requireAuth` is opt-in per
//     route, and this route never calls it.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { getDb } from "../../db/client.ts";
import { BOOTSTRAP_LLM_PROVIDERS, consume, isBootstrapPending } from "../../onboarding/index.ts";
import { seedBuiltinRolesAndPermissions } from "../../rbac/index.ts";
import type { AppEnv } from "../openapi.ts";

// -------- schemas --------

const SetupRequestBody = z
  .object({
    token: z.string().min(64).max(128),
    admin_email: z.string().email().min(3).max(254),
    tenant_name: z.string().min(1).max(120),
    llm_provider: z.enum(BOOTSTRAP_LLM_PROVIDERS),
    llm_api_key: z.string().min(1).max(4096),
  })
  .openapi("SetupRequestBody");

const SetupResponse = z
  .object({
    tenant_id: z.string().uuid(),
    user_id: z.string().uuid(),
    api_key: z.string(),
    api_key_prefix: z.string(),
  })
  .openapi("SetupResponse");

const SetupStatusResponse = z
  .object({
    pending: z.boolean(),
  })
  .openapi("SetupStatusResponse");

// -------- routes --------

const statusRoute = createRoute({
  method: "get",
  path: "/v1/setup",
  tags: ["setup"],
  summary: "Check whether first-run bootstrap is still pending",
  description:
    "Returns `{pending: true}` until the operator completes the first-run setup wizard. Drives the `sk init` health probe so the CLI can refuse to prompt against an already-bootstrapped engine.",
  responses: {
    200: {
      description: "Bootstrap state",
      content: { "application/json": { schema: SetupStatusResponse } },
    },
  },
});

const postRoute = createRoute({
  method: "post",
  path: "/v1/setup",
  tags: ["setup"],
  summary: "Redeem the first-run bootstrap token and materialise tenant + admin",
  description:
    "Consumes the one-time token printed to engine stdout on a fresh install. Creates the tenant, admin user, admin API key, writes the LLM provider settings, and flips the post-bootstrap sentinel. The returned `api_key` is the only time the plaintext key is ever returned.",
  request: {
    body: { content: { "application/json": { schema: SetupRequestBody } } },
  },
  responses: {
    200: {
      description: "Bootstrap completed; admin API key returned",
      content: { "application/json": { schema: SetupResponse } },
    },
    400: {
      description: "Payload failed Zod validation",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Token missing, expired, or did not match",
      content: { "application/json": { schema: ErrorSchema } },
    },
    410: {
      description: "Bootstrap already completed; route is gone",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded for this client IP",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// -------- handler --------

function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return headers.get("x-real-ip") ?? "unknown";
}

export function registerSetupRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(statusRoute, async (c) => {
    const db = c.get("db") ?? getDb();
    const pending = await isBootstrapPending(db);
    return c.json({ pending }, 200);
  });

  app.openapi(postRoute, async (c) => {
    const db = c.get("db") ?? getDb();
    const body = c.req.valid("json");
    const ip = clientIp(c.req.raw.headers);
    const userAgent = c.req.raw.headers.get("user-agent");

    // RBAC seed needs to have run already (engine boot does this), but
    // be defensive — calling it twice is idempotent and cheap.
    const rbacIds = await seedBuiltinRolesAndPermissions(db);

    const outcome = await consume(
      db,
      rbacIds,
      {
        admin_email: body.admin_email,
        tenant_name: body.tenant_name,
        llm_provider: body.llm_provider,
        llm_api_key: body.llm_api_key,
      },
      { token: body.token, ip, user_agent: userAgent },
    );

    if (outcome.status === "ok") {
      return c.json(
        {
          tenant_id: outcome.tenant_id,
          user_id: outcome.user_id,
          api_key: outcome.api_key_plaintext,
          api_key_prefix: outcome.api_key_prefix,
        },
        200,
      );
    }

    switch (outcome.code) {
      case "gone":
        return c.json({ code: "gone", message: outcome.message }, 410);
      case "rate_limited":
        return c.json({ code: "rate_limit_exceeded", message: outcome.message }, 429);
      case "invalid_token":
      case "token_expired":
        return c.json({ code: outcome.code, message: outcome.message }, 401);
      case "validation_failed":
        return c.json({ code: "validation_failed", message: outcome.message }, 400);
    }
  });
}
