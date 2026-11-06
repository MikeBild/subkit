import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { deliveries } from "../../db/schema/webhooks.ts";
import { getSubscription } from "../../webhooks/outbound/service.ts";
import { IdParam, PaginationQuery, paginatedResponse } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const DEFAULT_LIMIT = 50;

const DeliverySchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    subscription_id: z.string(),
    event_id: z.string(),
    event_type: z.string().nullable(),
    outbox_event_id: z.number().nullable(),
    attempt: z.number().int(),
    attempt_number: z.number().int(),
    status: z.string(),
    response_code: z.number().int().nullable(),
    error: z.string().nullable(),
    classification: z.string().nullable(),
    terminal_reason: z.string().nullable(),
    target_url: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    next_retry_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("SubscriptionDelivery");

const DeliveryListResponse = paginatedResponse(DeliverySchema, "SubscriptionDeliveryListResponse");

type DeliveryRow = typeof deliveries.$inferSelect;
type PageQuery = z.infer<typeof PaginationQuery>;

interface ListInput extends PageQuery {
  readonly id: string;
}

async function listSubscriptionDeliveries(
  db: Db,
  tenantId: string,
  subscriptionId: string,
  page: { limit: number; offset: number },
): Promise<DeliveryRow[]> {
  return await db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.tenant_id, tenantId), eq(deliveries.subscription_id, subscriptionId)))
    .orderBy(desc(deliveries.created_at), desc(deliveries.id))
    .limit(page.limit)
    .offset(page.offset);
}

function serialize(row: DeliveryRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subscription_id: row.subscription_id,
    event_id: row.event_id,
    event_type: row.event_type,
    outbox_event_id: row.outbox_event_id,
    attempt: row.attempt,
    attempt_number: row.attempt_number,
    status: row.status,
    response_code: row.response_code,
    error: row.error,
    classification: row.classification,
    terminal_reason: row.terminal_reason,
    target_url: row.target_url,
    duration_ms: row.duration_ms,
    next_retry_at: row.next_retry_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export const listSubscriptionDeliveriesOperation = defineOperation<ListInput, DeliveryRow[]>({
  id: "subscription.list_deliveries",
  summary: "List the delivery attempts of a subscription, newest first",
  permission: "subscription:read",
  resource: { type: "subscription", param: "id" },
  effect: "read",
  async handler(scope, { id, limit, offset }) {
    const subscription = await getSubscription(scope.tenant_id, id, scope.db);
    if (!subscription) return reject.notFound("subscription");
    return await listSubscriptionDeliveries(scope.db, scope.tenant_id, id, {
      limit: limit ?? DEFAULT_LIMIT,
      offset: offset ?? 0,
    });
  },
  http: {
    method: "get",
    path: "/v1/subscriptions/{id}/deliveries",
    tags: ["webhooks"],
    params: IdParam,
    query: PaginationQuery,
    response: DeliveryListResponse,
    errors: { 404: "Not found" },
    toInput: ({ param, query }) => ({
      id: (param as { id: string }).id,
      ...(query as PageQuery),
    }),
    toBody: (rows) => ({ items: rows.map(serialize) }),
  },
});
