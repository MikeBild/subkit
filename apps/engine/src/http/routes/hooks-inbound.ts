import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { actorOf } from "../../audit/index.ts";
import { getBoss } from "../../queue/index.ts";
import * as svc from "../../webhooks/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const InboundSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    workflow_id: z.string(),
    verifier: z.enum(["standard", "github", "stripe", "hmac", "custom"]),
    active: z.boolean(),
    origin: z.enum(["crud", "trigger"]),
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
    verifier: z.enum(["standard", "github", "stripe", "hmac", "custom"]),
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
    409: {
      description: "The slug is already in use; inbound hook slugs are unique across the engine",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
    let nativeConfig = body.native_verifier_config ?? null;
    if (body.verifier === "hmac") {
      const parsed = svc.HmacVerifierConfig.safeParse(nativeConfig?.hmac);
      if (!parsed.success) {
        throw new BadRequestError(
          `native_verifier_config.hmac is invalid: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "hmac"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      nativeConfig = { ...nativeConfig, hmac: parsed.data };
    }
    const row = await svc
      .createInbound(
        {
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
          actor: actorOf(principal),
          slug: body.slug,
          workflow_id: body.workflow_id,
          verifier: body.verifier === "custom" ? "standard" : body.verifier,
          secret: body.secret,
          native_verifier_config: nativeConfig,
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
        db,
      )
      .catch((err: unknown) => {
        if (err instanceof svc.InboundSlugTakenError)
          throw new ConflictError(
            `slug "${body.slug}" is already in use; choose a different slug for this hook`,
          );
        throw err;
      });
    return c.json(serialize(row), 201);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await svc.deleteInbound(principal.tenant_id, id, actorOf(principal), db);
    if (!ok) throw new NotFoundError("webhook_inbound");
    return c.json({ deleted: true }, 200);
  });

  app.post("/v1/hooks/:slug", async (c) => {
    const slug = c.req.param("slug");
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const db = c.get("db");
    const bossOverride = (c as unknown as { get: (k: string) => unknown }).get("boss") as
      | ReturnType<typeof getBoss>
      | undefined;
    const boss = bossOverride ?? getBoss();
    const outcome = await svc.handleInbound({ db, boss }, { slug, headers, rawBody });
    if (outcome.status === "not_found") {
      return c.json({ error: "not_found" }, 404);
    }
    if (outcome.status === "held") {
      return c.json({ status: "held", reason: outcome.reason }, 202);
    }
    if (outcome.status === "denied") {
      return c.json(
        {
          error: "denied",
          reason: outcome.reason,
          ...(outcome.hint ? { hint: outcome.hint } : {}),
        },
        outcome.reason === "held_delivery_over_capacity"
          ? 429
          : outcome.reason === "held_delivery_too_large"
            ? 413
            : outcome.reason.startsWith("execution_") ||
                outcome.reason.startsWith("workflow_") ||
                outcome.reason === "input_schema_violation"
              ? 409
              : 401,
      );
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
