import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { notificationDeliveries } from "../../../db/schema/notifications.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const DeliverySchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    rule_id: z.string().nullable(),
    channel_id: z.string().nullable(),
    event_type: z.string(),
    severity: z.string(),
    status: z.string(),
    reason: z.string().nullable(),
    error: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("NotificationDelivery");

const DeliveryListResponse = z
  .object({ items: z.array(DeliverySchema) })
  .openapi("NotificationDeliveryListResponse");

const DeliveryQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  status: z.string().optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/v1/notifications/deliveries",
  tags: ["notifications"],
  summary: "List recent notification deliveries",
  security: [{ bearerAuth: [] }],
  request: { query: DeliveryQuery },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DeliveryListResponse } },
    },
  },
});

export function registerDeliveryRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/notifications/deliveries", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("notification:read")(c, next);
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const limit = Math.min(q.limit ?? 50, 500);
    const offset = q.offset ?? 0;
    const tenantWhereClauses = [eq(notificationDeliveries.tenant_id, principal.tenant_id)];
    if (q.status) {
      tenantWhereClauses.push(eq(notificationDeliveries.status, q.status));
    }
    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(tenantWhereClauses.length === 1 ? tenantWhereClauses[0] : and(...tenantWhereClauses))
      .orderBy(desc(notificationDeliveries.created_at))
      .limit(limit)
      .offset(offset);
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          tenant_id: r.tenant_id,
          rule_id: r.rule_id,
          channel_id: r.channel_id,
          event_type: r.event_type,
          severity: r.severity,
          status: r.status,
          reason: r.reason,
          error: r.error,
          created_at: r.created_at.toISOString(),
        })),
      },
      200,
    );
  });
}
