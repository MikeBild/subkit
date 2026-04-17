// Inbound webhook HTTP surface.
//
//   POST   /v1/webhooks/inbound          — create slug binding (authed)
//   GET    /v1/webhooks/inbound          — list bindings
//   GET    /v1/webhooks/inbound/:id      — fetch one
//   DELETE /v1/webhooks/inbound/:id      — remove one
//   POST   /v1/hooks/:slug               — public ingestion endpoint
//                                          (signature IS the auth)

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { getBoss } from "../../queue/boss.ts";
import * as svc from "../../webhooks/inbound/service.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const InboundSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    workflow_id: z.string(),
    verifier: z.enum(["standard", "github", "stripe", "custom"]),
    active: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("WebhookInbound");

const ListResponse = z
  .object({ items: z.array(InboundSchema) })
  .openapi("WebhookInboundListResponse");

const CreateBody = z
  .object({
    slug: z.string().min(1),
    workflow_id: z.string().uuid(),
    verifier: z.enum(["standard", "github", "stripe", "custom"]),
    secret: z.string().min(1),
    native_verifier_config: z.record(z.string(), z.unknown()).optional(),
    active: z.boolean().optional(),
  })
  .openapi("CreateWebhookInboundBody");

function serialize(row: svc.InboundRow) {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/webhooks/inbound",
  tags: ["webhooks"],
  summary: "List inbound webhook bindings",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/webhooks/inbound/{id}",
  tags: ["webhooks"],
  summary: "Fetch an inbound webhook binding",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: InboundSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/webhooks/inbound",
  tags: ["webhooks"],
  summary: "Create an inbound webhook binding",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: InboundSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/webhooks/inbound/{id}",
  tags: ["webhooks"],
  summary: "Delete an inbound webhook binding",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerHooksInboundRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC gating for the authenticated CRUD surface. The public
  // `POST /v1/hooks/:slug` ingress is left untouched — signature auth
  // is the gate there.
  app.use("/v1/webhooks/inbound", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("inbound_hook:read")(c, next);
    if (c.req.method === "POST") return requirePermission("inbound_hook:write")(c, next);
    return next();
  });
  app.use("/v1/webhooks/inbound/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("inbound_hook:read", () => ({ type: "inbound_hook", id }))(c, next);
    }
    if (c.req.method === "DELETE") {
      return requirePermission("inbound_hook:delete", () => ({ type: "inbound_hook", id }))(
        c,
        next,
      );
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await svc.listInbound(principal.tenant_id, db);
    return c.json({ items: items.map(serialize) }, 200);
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await svc.getInbound(principal.tenant_id, id, db);
    if (!row) throw new NotFoundError("webhook_inbound");
    return c.json(serialize(row), 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const row = await svc.createInbound(
      {
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        slug: body.slug,
        workflow_id: body.workflow_id,
        verifier: body.verifier === "custom" ? "standard" : body.verifier,
        secret: body.secret,
        native_verifier_config: body.native_verifier_config ?? null,
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      db,
    );
    return c.json(serialize(row), 201);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await svc.deleteInbound(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("webhook_inbound");
    return c.json({ deleted: true }, 200);
  });

  // POST /v1/hooks/:slug — unauthenticated ingress.
  app.post("/v1/hooks/:slug", async (c) => {
    const slug = c.req.param("slug");
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const db = c.get("db");
    // Resolve pg-boss lazily: tests without a boss can pass one via
    // c.get("boss") (the openapi type isn't strict about extras).
    const bossOverride = (c as unknown as { get: (k: string) => unknown }).get("boss") as
      | ReturnType<typeof getBoss>
      | undefined;
    const boss = bossOverride ?? getBoss();
    const outcome = await svc.handleInbound({ db, boss }, { slug, headers, rawBody });
    if (outcome.status === "not_found") {
      return c.json({ error: "not_found" }, 404);
    }
    if (outcome.status === "denied") {
      return c.json({ error: "denied", reason: outcome.reason }, 401);
    }
    if (outcome.status === "deduped") {
      return c.json({ deduped: true, inbound_id: outcome.inbound_id }, 200);
    }
    return c.json(
      {
        accepted: true,
        inbound_id: outcome.inbound_id,
        execution_id: outcome.execution_id,
        webhook_id: outcome.normalized.id,
      },
      200,
    );
  });
}
