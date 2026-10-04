import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { policy } from "../../../auth/index.ts";
import * as identity from "../../../identity/index.ts";
import { now } from "../../../utils/clock.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { InviteRedeemedSchema, UserInviteIssuedSchema, UserInviteSchema } from "./schemas.ts";

const REDEEM_MAX_ATTEMPTS = 5;
const REDEEM_WINDOW_MS = 15 * 60 * 1000;
const REDEEM_MAX_TRACKED_IPS = 10_000;
const redeemAttempts = new Map<string, { count: number; window_started_at: number }>();

export function _resetInviteRedeemRateLimitForTests(): void {
  redeemAttempts.clear();
}

function evictRedeemAttempts(at: number): void {
  for (const [ip, entry] of redeemAttempts) {
    if (at - entry.window_started_at > REDEEM_WINDOW_MS) redeemAttempts.delete(ip);
  }
  while (redeemAttempts.size >= REDEEM_MAX_TRACKED_IPS) {
    const oldest = redeemAttempts.keys().next().value;
    if (oldest === undefined) break;
    redeemAttempts.delete(oldest);
  }
}

function checkRedeemRateLimit(ip: string): boolean {
  const at = now();
  const entry = redeemAttempts.get(ip);
  if (!entry || at - entry.window_started_at > REDEEM_WINDOW_MS) {
    if (!redeemAttempts.has(ip)) evictRedeemAttempts(at);
    redeemAttempts.set(ip, { count: 1, window_started_at: at });
    return true;
  }
  if (entry.count >= REDEEM_MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return headers.get("x-real-ip") ?? "unknown";
}

const CreateInviteBody = z
  .object({
    scopes: z.array(z.string()).optional(),
    allowed_workflows: z.array(z.string()).optional(),
    allowed_connectors: z.array(z.string()).optional(),
    ttl_minutes: z
      .number()
      .int()
      .positive()
      .max(90 * 24 * 60)
      .optional(),
  })
  .openapi("CreateInviteBody");

const RedeemInviteBody = z
  .object({
    token: z.string().min(14).max(128),
  })
  .openapi("RedeemInviteBody");

const InviteListResponse = z
  .object({ items: z.array(UserInviteSchema) })
  .openapi("UserInviteListResponse");

const createInviteRoute = createRoute({
  method: "post",
  path: "/v1/identity/users/{id}/invites",
  tags: ["identity"],
  summary: "Issue a single-use provisioning invite for a user",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: CreateInviteBody } } },
  },
  security: [{ bearerAuth: [] }],
  responses: {
    201: {
      description: "Created; plaintext invite token returned once",
      content: { "application/json": { schema: UserInviteIssuedSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listInvitesRoute = createRoute({
  method: "get",
  path: "/v1/identity/invites",
  tags: ["identity"],
  summary: "List invites in the caller's tenant",
  request: {
    query: z.object({
      status: z.enum(["pending", "redeemed", "revoked", "expired"]).optional(),
    }),
  },
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: InviteListResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeInviteRoute = createRoute({
  method: "delete",
  path: "/v1/identity/invites/{id}",
  tags: ["identity"],
  summary: "Revoke an un-redeemed invite",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Revoked" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const redeemInviteRoute = createRoute({
  method: "post",
  path: "/v1/identity/invites/redeem",
  tags: ["identity"],
  summary: "Redeem an invite to mint the invited user's personal API key",
  description:
    "Unauthenticated. The invite token in the body is the proof. On success returns the invited user's personal API key plaintext exactly once — the issuing admin never sees it.",
  request: { body: { content: { "application/json": { schema: RedeemInviteBody } } } },
  responses: {
    200: {
      description: "Redeemed; personal API key returned",
      content: { "application/json": { schema: InviteRedeemedSchema } },
    },
    400: {
      description: "Invalid, expired, revoked, or already-redeemed invite",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded for this client IP",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function serialize(v: identity.InviteView) {
  return {
    id: v.id,
    tenant_id: v.tenant_id,
    user_id: v.user_id,
    prefix: v.prefix,
    scopes: v.scopes,
    allowed_workflows: v.allowed_workflows,
    allowed_connectors: v.allowed_connectors,
    expires_at: v.expires_at.toISOString(),
    redeemed_at: v.redeemed_at ? v.redeemed_at.toISOString() : null,
    revoked_at: v.revoked_at ? v.revoked_at.toISOString() : null,
    created_by: v.created_by,
    created_at: v.created_at.toISOString(),
  };
}

export function registerInviteRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/identity/users/:id/invites", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("identity:write")(c, next);
    return next();
  });
  app.use("/v1/identity/invites", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("identity:read")(c, next);
    return next();
  });
  app.use("/v1/identity/invites/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "DELETE") {
      return requirePermission("identity:write", () => ({ type: "user_invite", id }))(c, next);
    }
    return next();
  });

  app.openapi(createInviteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user_invite", resource_id: id },
      db,
    );
    const user = await identity.getUser(principal.tenant_id, id, db);
    if (!user) throw new NotFoundError("user");

    const body = c.req.valid("json");
    const result = await identity.createInvite(
      {
        tenant_id: principal.tenant_id,
        user_id: id,
        ...(body.scopes ? { scopes: body.scopes } : {}),
        ...(body.allowed_workflows ? { allowed_workflows: body.allowed_workflows } : {}),
        ...(body.allowed_connectors ? { allowed_connectors: body.allowed_connectors } : {}),
        ...(body.ttl_minutes !== undefined ? { ttl_minutes: body.ttl_minutes } : {}),
        actor_id: principal.id,
      },
      db,
    );
    return c.json({ ...serialize(result.view), plaintext_token: result.plaintext }, 201);
  });

  app.openapi(listInvitesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "user_invite" }, db);
    const q = c.req.valid("query");
    const items = await identity.listInvites(
      principal.tenant_id,
      q.status ? { status: q.status } : {},
      db,
    );
    return c.json({ items: items.map(serialize) }, 200);
  });

  app.openapi(revokeInviteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user_invite", resource_id: id },
      db,
    );
    const row = await identity.revokeInvite(
      { tenant_id: principal.tenant_id, invite_id: id, actor_id: principal.id },
      db,
    );
    if (!row) throw new NotFoundError("user_invite");
    return c.body(null, 204);
  });

  app.openapi(redeemInviteRoute, async (c) => {
    const db = c.get("db");
    const ip = clientIp(c.req.raw.headers);
    if (!checkRedeemRateLimit(ip)) {
      return c.json(
        { code: "rate_limit_exceeded", message: "too many redeem attempts from this IP" },
        429,
      );
    }
    const body = c.req.valid("json");
    const outcome = await identity.redeemInvite({ token: body.token }, db);
    if (!outcome.ok) {
      return c.json(
        { code: outcome.code, message: `invite redemption failed: ${outcome.code}` },
        400,
      );
    }
    return c.json(
      {
        user_id: outcome.user_id,
        tenant_id: outcome.tenant_id,
        api_key: outcome.api_key.plaintext,
        api_key_prefix: outcome.api_key.view.prefix,
      },
      200,
    );
  });
}
