import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { getDb } from "../../db/client.ts";
import type { LlmAccessProbe } from "../../llm/core/access-probe.ts";
import {
  BOOTSTRAP_LLM_PROVIDERS,
  consume,
  isBootstrapPending,
  isBootstrapTokenExpired,
} from "../../onboarding/index.ts";
import { seedBuiltinRolesAndPermissions } from "../../rbac/index.ts";
import type { AppEnv } from "../openapi.ts";

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
    token_expired: z.boolean(),
  })
  .openapi("SetupStatusResponse");

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
    "Consumes the one-time token printed to engine stdout on a fresh install. Checks the LLM key with one live probe call first (provider `mock` passes without a call); a refused key answers 422 `llm_unreachable` and saves nothing. Then creates the tenant, admin user, admin API key, writes the LLM provider settings, and flips the post-bootstrap sentinel. The returned `api_key` is the only time the plaintext key is ever returned.",
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
    422: {
      description:
        "The LLM provider did not accept the key in a live probe call (`llm_unreachable`); nothing was saved and the token stays valid",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded for this client IP",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const bootstrapStatusRoute = createRoute({
  method: "get",
  path: "/v1/bootstrap/status",
  tags: ["bootstrap"],
  summary: "Read the common first-run bootstrap state",
  responses: {
    200: {
      description: "Bootstrap state",
      content: {
        "application/json": {
          schema: SetupStatusResponse.extend({
            completed: z.boolean(),
          }).openapi("BootstrapStatusResponse"),
        },
      },
    },
  },
});

const bootstrapCompleteRoute = createRoute({
  method: "post",
  path: "/v1/bootstrap/complete",
  tags: ["bootstrap"],
  summary: "Complete first-run bootstrap using the one-time bootstrap key",
  request: {
    body: { content: { "application/json": { schema: SetupRequestBody } } },
  },
  responses: postRoute.responses,
});

function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return headers.get("x-real-ip") ?? "unknown";
}

export function registerSetupRoute(
  app: OpenAPIHono<AppEnv>,
  deps: { probe?: LlmAccessProbe } = {},
): void {
  app.openapi(statusRoute, async (c) => {
    const db = c.get("db") ?? getDb();
    const pending = await isBootstrapPending(db);
    const token_expired = pending ? await isBootstrapTokenExpired(db) : false;
    return c.json({ pending, token_expired }, 200);
  });

  app.openapi(postRoute, async (c) => {
    const db = c.get("db") ?? getDb();
    const body = c.req.valid("json");
    const ip = clientIp(c.req.raw.headers);
    const userAgent = c.req.raw.headers.get("user-agent");

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
      {
        token: body.token,
        ip,
        user_agent: userAgent,
        ...(deps.probe ? { probe: deps.probe } : {}),
      },
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
        return c.json(
          {
            code: outcome.code,
            message: outcome.message,
            ...(outcome.hint ? { hint: outcome.hint } : {}),
          },
          401,
        );
      case "validation_failed":
        return c.json({ code: "validation_failed", message: outcome.message }, 400);
      case "llm_unreachable":
        return c.json(
          {
            code: outcome.code,
            message: outcome.message,
            ...(outcome.hint ? { hint: outcome.hint } : {}),
          },
          422,
        );
    }
  });

  app.openapi(bootstrapStatusRoute, async (c) => {
    const db = c.get("db") ?? getDb();
    const pending = await isBootstrapPending(db);
    const token_expired = pending ? await isBootstrapTokenExpired(db) : false;
    return c.json({ pending, completed: !pending, token_expired }, 200);
  });

  app.openapi(bootstrapCompleteRoute, async (c) => {
    const db = c.get("db") ?? getDb();
    const body = c.req.valid("json");
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
      {
        token: body.token,
        ip: clientIp(c.req.raw.headers),
        user_agent: c.req.raw.headers.get("user-agent"),
        ...(deps.probe ? { probe: deps.probe } : {}),
      },
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
        return c.json(
          {
            code: outcome.code,
            message: outcome.message,
            ...(outcome.hint ? { hint: outcome.hint } : {}),
          },
          401,
        );
      case "validation_failed":
        return c.json({ code: "validation_failed", message: outcome.message }, 400);
      case "llm_unreachable":
        return c.json(
          {
            code: outcome.code,
            message: outcome.message,
            ...(outcome.hint ? { hint: outcome.hint } : {}),
          },
          422,
        );
    }
  });
}
