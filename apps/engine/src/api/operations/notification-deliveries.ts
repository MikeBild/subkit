import { z } from "@hono/zod-openapi";
import {
  listRecentDeliveries,
  type NotificationDeliveryRow,
} from "../../notifications/admin/deliveries.ts";
import { defineOperation } from "./index.ts";

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

type DeliveryQueryInput = z.infer<typeof DeliveryQuery>;

export const listNotificationDeliveriesOperation = defineOperation<
  DeliveryQueryInput,
  NotificationDeliveryRow[]
>({
  id: "notification_delivery.list",
  summary: "List recent notification deliveries",
  permission: "notification:read",
  effect: "read",
  handler: (scope, q) =>
    listRecentDeliveries(scope.db, scope.tenant_id, {
      limit: Math.min(q.limit ?? 50, 500),
      offset: q.offset ?? 0,
      status: q.status,
    }),
  http: {
    method: "get",
    path: "/v1/notifications/deliveries",
    tags: ["notifications"],
    query: DeliveryQuery,
    response: DeliveryListResponse,
    toInput: ({ query }) => query as DeliveryQueryInput,
    toBody: (rows) => ({
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
    }),
  },
});
