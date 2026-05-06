// Subscriptions HTTP surface.
//
//   GET    /v1/subscriptions
//   GET    /v1/subscriptions/:id
//   POST   /v1/subscriptions
//   PATCH  /v1/subscriptions/:id
//   DELETE /v1/subscriptions/:id
//   POST   /v1/subscriptions/:id/deliveries/:delivery_id/replay

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { AuditAction, audit } from "../../audit/index.ts";
import { deliveries, events } from "../../db/schema/index.ts";
import { getBoss } from "../../queue/index.ts";
import * as svc from "../../webhooks/index.ts";
import { WEBHOOK_DELIVER_QUEUE, type WebhookDeliverJob } from "../../webhooks/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ReplayParams = z.object({
  id: z.string().uuid(),
  delivery_id: z.string().uuid(),
});

const SubscriptionSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    event_pattern: z.string(),
    target_url: z.string(),
    active: z.boolean(),
    consecutive_failures: z.number(),
    circuit_open_until: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Subscription");

const ListResponse = z
  .object({ items: z.array(SubscriptionSchema) })
  .openapi("SubscriptionListResponse");

const CreateBody = z
  .object({
    event_pattern: z.string().min(1),
    target_url: z.string().url(),
    secret: z.string().min(1),
    active: z.boolean().optional(),
  })
  .openapi("CreateSubscriptionBody");

const UpdateBody = z
  .object({
    event_pattern: z.string().min(1).optional(),
    target_url: z.string().url().optional(),
    secret: z.string().min(1).optional(),
    rotating_secret: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .openapi("UpdateSubscriptionBody");

function serialize(row: svc.SubscriptionRow) {
  return {
    ...row,
    circuit_open_until: row.circuit_open_until ? row.circuit_open_until.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/subscriptions",
  tags: ["webhooks"],
  summary: "List subscriptions",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/subscriptions/{id}",
  tags: ["webhooks"],
  summary: "Fetch a subscription",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SubscriptionSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/subscriptions",
  tags: ["webhooks"],
  summary: "Create a subscription",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: SubscriptionSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/v1/subscriptions/{id}",
  tags: ["webhooks"],
  summary: "Update a subscription",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SubscriptionSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/subscriptions/{id}",
  tags: ["webhooks"],
  summary: "Delete a subscription",
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

const replayRoute = createRoute({
  method: "post",
  path: "/v1/subscriptions/{id}/deliveries/{delivery_id}/replay",
  tags: ["webhooks"],
  summary: "Replay a failed delivery",
  security: [{ bearerAuth: [] }],
  request: { params: ReplayParams },
  responses: {
    202: {
      description: "Accepted",
      content: {
        "application/json": { schema: z.object({ replayed: z.boolean() }) },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSubscriptionRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC gating.
  app.use("/v1/subscriptions", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("subscription:read")(c, next);
    if (c.req.method === "POST") return requirePermission("subscription:write")(c, next);
    return next();
  });
  app.use("/v1/subscriptions/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("subscription:read", () => ({ type: "subscription", id }))(c, next);
    }
    if (c.req.method === "PATCH") {
      return requirePermission("subscription:write", () => ({ type: "subscription", id }))(c, next);
    }
    if (c.req.method === "DELETE") {
      return requirePermission("subscription:delete", () => ({ type: "subscription", id }))(
        c,
        next,
      );
    }
    return next();
  });
  app.use("/v1/subscriptions/:id/deliveries/:delivery_id/replay", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("subscription:replay", () => ({ type: "subscription", id }))(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await svc.listSubscriptions(principal.tenant_id, db);
    return c.json({ items: items.map(serialize) }, 200);
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await svc.getSubscription(principal.tenant_id, id, db);
    if (!row) throw new NotFoundError("subscription");
    return c.json(serialize(row), 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const row = await svc.createSubscription(
      {
        tenant_id: principal.tenant_id,
        actor_id: principal.id,
        event_pattern: body.event_pattern,
        target_url: body.target_url,
        secret: body.secret,
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      db,
    );
    return c.json(serialize(row), 201);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await svc.updateSubscription(
      {
        tenant_id: principal.tenant_id,
        id,
        actor_id: principal.id,
        ...(body.event_pattern !== undefined ? { event_pattern: body.event_pattern } : {}),
        ...(body.target_url !== undefined ? { target_url: body.target_url } : {}),
        ...(body.secret !== undefined ? { secret: body.secret } : {}),
        ...(body.rotating_secret !== undefined ? { rotating_secret: body.rotating_secret } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      db,
    );
    if (!row) throw new NotFoundError("subscription");
    return c.json(serialize(row), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await svc.deleteSubscription(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("subscription");
    return c.json({ deleted: true }, 200);
  });

  app.openapi(replayRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, delivery_id } = c.req.valid("param");
    const rows = await db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenant_id, principal.tenant_id),
          eq(deliveries.subscription_id, id),
          eq(deliveries.id, delivery_id),
        ),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) throw new NotFoundError("delivery");
    const bossOverride = (c as unknown as { get: (k: string) => unknown }).get("boss") as
      | ReturnType<typeof getBoss>
      | undefined;
    const boss = bossOverride ?? getBoss();

    // Reconstruct the original payload from the outbox row so the replay
    // produces an identical body + signature — essential for subscribers
    // that rely on event dedup by request_hash. Fall back to a minimal
    // replay envelope when the outbox event has been pruned.
    const timestamp = Math.floor(Date.now() / 1000);
    let body: string;
    if (existing.outbox_event_id != null) {
      const outboxRows = await db
        .select()
        .from(events)
        .where(
          and(eq(events.tenant_id, principal.tenant_id), eq(events.id, existing.outbox_event_id)),
        )
        .limit(1);
      const outbox = outboxRows[0];
      if (outbox) {
        body = JSON.stringify({
          type: outbox.type,
          timestamp,
          data: outbox.payload,
          replay: true,
          original_delivery_id: delivery_id,
        });
      } else {
        body = JSON.stringify({
          type: existing.event_type ?? "replay",
          timestamp,
          data: null,
          replay: true,
          original_delivery_id: delivery_id,
          note: "original outbox event unavailable",
        });
      }
    } else {
      body = JSON.stringify({
        type: existing.event_type ?? "replay",
        timestamp,
        data: null,
        replay: true,
        original_delivery_id: delivery_id,
      });
    }

    const job: WebhookDeliverJob = {
      tenant_id: principal.tenant_id,
      subscription_id: id,
      event_id: existing.event_id,
      event_type: existing.event_type ?? "replay",
      body,
      webhook_id: crypto.randomUUID(),
      timestamp,
      attempt_number: 1,
      outbox_event_id: existing.outbox_event_id ?? null,
    };
    await boss.send(WEBHOOK_DELIVER_QUEUE, job);
    audit(
      {
        tenant_id: principal.tenant_id,
        action: AuditAction.WEBHOOK_OUTBOUND_REPLAYED,
        resource_type: "subscription",
        resource_id: id,
        result: "success",
        metadata: {
          delivery_id,
          outbox_event_id: existing.outbox_event_id ?? null,
          original_terminal_reason: existing.terminal_reason ?? null,
          original_classification: existing.classification ?? null,
        },
      },
      db,
    );
    return c.json({ replayed: true }, 202);
  });
}
