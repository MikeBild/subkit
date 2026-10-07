import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { ErrorSchema, paginatedResponse } from "../../api/common-schemas.ts";
import { AuditAction, audit } from "../../audit/index.ts";
import { writeEvent } from "../../db/events.ts";
import { events } from "../../db/schema/index.ts";
import { getBoss } from "../../queue/index.ts";
import { EVENT_TYPES, fanoutEvent, validateEventPayload } from "../../webhooks/index.ts";
import { BadRequestError, ForbiddenError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { streamOutboxTail } from "./sse-outbox-tail.ts";

const EventSchema = z
  .object({
    id: z.number(),
    tenant_id: z.string(),
    channel: z.string(),
    type: z.string(),
    payload: z.unknown(),
    created_at: z.string(),
  })
  .openapi("OutboxEvent");

const ListResponse = paginatedResponse(EventSchema, "OutboxEventListResponse");

const EmitBody = z
  .object({
    type: z.enum(EVENT_TYPES as [string, ...string[]]),
    payload: z.record(z.string(), z.unknown()),
    channel: z.string().optional(),
  })
  .openapi("EmitEventBody");

const listRoute = createRoute({
  method: "get",
  path: "/v1/events",
  tags: ["events"],
  summary: "Tail outbox events for the caller's tenant",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
        channel: z.string().optional(),
        type: z.string().optional(),
      })
      .openapi("ListEventsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
  },
});

const emitRoute = createRoute({
  method: "post",
  path: "/v1/events",
  tags: ["events"],
  summary: "Manually emit an event (admin only)",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: EmitBody } } } },
  responses: {
    202: {
      description: "Accepted",
      content: { "application/json": { schema: z.object({ event_id: z.number() }) } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerEventRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/events", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("audit:read")(c, next);
    if (c.req.method === "POST") return requirePermission("audit:read")(c, next);
    return next();
  });
  app.use("/v1/events/stream", async (c, next) => {
    return requirePermission("audit:read")(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    if (principal.product_id) throw new ForbiddenError("product_caller_forbidden");
    const db = c.get("db");
    const q = c.req.valid("query");
    const tenantConds = [eq(events.tenant_id, principal.tenant_id)];
    if (q.channel) tenantConds.push(eq(events.channel, q.channel));
    if (q.type) tenantConds.push(eq(events.type, q.type));
    const rows = await db
      .select()
      .from(events)
      .where(and(...tenantConds))
      .orderBy(desc(events.id))
      .limit(q.limit ?? 100);
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenant_id: r.tenant_id,
          channel: r.channel,
          type: r.type,
          payload: r.payload,
          created_at: r.created_at.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(emitRoute, async (c) => {
    const principal = requireAuth(c);
    if (principal.product_id) throw new ForbiddenError("product_caller_forbidden");
    if (!principal.roles.includes("admin")) {
      throw new ForbiddenError("admin_required");
    }
    const db = c.get("db");
    const body = c.req.valid("json");
    const check = validateEventPayload(body.type, body.payload);
    if (!check.ok) {
      throw new BadRequestError(`payload invalid: ${check.error}`);
    }
    const channel = (body.channel ?? "event.emitted") as
      | "execution.status"
      | "workflow.chain"
      | "workflow.lifecycle"
      | "connector.oauth"
      | "conversation.stream"
      | "event.emitted"
      | "notification.emitted";
    const event_id = await db.transaction(async (tx) => {
      return await writeEvent(tx, {
        tenant_id: principal.tenant_id,
        channel,
        type: body.type,
        payload: body.payload,
      });
    });
    audit(
      {
        tenant_id: principal.tenant_id,
        action: AuditAction.EVENT_EMITTED,
        resource_type: "event",
        resource_id: String(event_id),
        result: "success",
        metadata: { type: body.type, channel },
      },
      db,
    );

    try {
      const bossOverride = (c as unknown as { get: (k: string) => unknown }).get("boss") as
        | ReturnType<typeof getBoss>
        | undefined;
      const boss = bossOverride ?? getBoss();
      await fanoutEvent({
        db,
        boss,
        tenant_id: principal.tenant_id,
        event_row_id: event_id,
        event_type: body.type,
        payload: body.payload,
      });
    } catch {}
    return c.json({ event_id }, 202);
  });

  app.get("/v1/events/stream", async (c) => {
    const principal = requireAuth(c);
    if (principal.product_id) throw new ForbiddenError("product_caller_forbidden");
    const db = c.get("db");
    const tenantId = principal.tenant_id;

    const rawExecutionId = c.req.query("execution_id") ?? null;
    if (rawExecutionId !== null) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(rawExecutionId)) {
        throw new BadRequestError("execution_id must be a UUID");
      }
    }
    const channelFilter = c.req.query("channel") ?? null;
    const typeFilter = c.req.query("type") ?? null;

    return streamOutboxTail(c, {
      db,
      replay: "recent",
      conds: () => {
        const tenantConds = [eq(events.tenant_id, tenantId)];
        if (rawExecutionId) {
          tenantConds.push(sql`${events.payload}->>'execution_id' = ${rawExecutionId}`);
        }
        if (channelFilter) tenantConds.push(eq(events.channel, channelFilter));
        if (typeFilter) tenantConds.push(eq(events.type, typeFilter));
        return tenantConds;
      },
    });
  });
}
