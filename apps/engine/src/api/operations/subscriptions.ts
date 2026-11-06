import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { getBoss } from "../../queue/index.ts";
import { replayDelivery } from "../../webhooks/outbound/replay.ts";
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  type SubscriptionRow,
  updateSubscription,
} from "../../webhooks/outbound/service.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

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

type CreateInput = z.infer<typeof CreateBody>;
type UpdateFields = z.infer<typeof UpdateBody>;

interface IdInput {
  readonly id: string;
}

interface UpdateInput extends IdInput {
  readonly body: UpdateFields;
}

interface ReplayInput {
  readonly id: string;
  readonly delivery_id: string;
}

function serialize(row: SubscriptionRow) {
  return {
    ...row,
    circuit_open_until: row.circuit_open_until ? row.circuit_open_until.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function idFrom(param: unknown): IdInput {
  return { id: (param as IdInput).id };
}

const SUBSCRIPTION_RESOURCE = { type: "subscription", param: "id" } as const;

export const listSubscriptionsOperation = defineOperation<Record<string, never>, SubscriptionRow[]>(
  {
    id: "subscription.list",
    summary: "List subscriptions",
    permission: "subscription:read",
    effect: "read",
    handler: (scope) => listSubscriptions(scope.tenant_id, scope.db),
    http: {
      method: "get",
      path: "/v1/subscriptions",
      tags: ["webhooks"],
      response: ListResponse,
      toInput: () => ({}),
      toBody: (items) => ({ items: items.map(serialize) }),
    },
  },
);

export const getSubscriptionOperation = defineOperation<IdInput, SubscriptionRow>({
  id: "subscription.get",
  summary: "Fetch a subscription",
  permission: "subscription:read",
  resource: SUBSCRIPTION_RESOURCE,
  effect: "read",
  async handler(scope, { id }) {
    return (
      (await getSubscription(scope.tenant_id, id, scope.db)) ?? reject.notFound("subscription")
    );
  },
  http: {
    method: "get",
    path: "/v1/subscriptions/{id}",
    tags: ["webhooks"],
    params: IdParam,
    response: SubscriptionSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: serialize,
  },
});

export const createSubscriptionOperation = defineOperation<CreateInput, SubscriptionRow>({
  id: "subscription.create",
  summary: "Create a subscription",
  permission: "subscription:write",
  effect: "write",
  audit: AuditAction.SUBSCRIPTION_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    return await createSubscription(
      {
        tenant_id: scope.tenant_id,
        actor_id: principal.id,
        actor: actorOf(principal),
        event_pattern: body.event_pattern,
        target_url: body.target_url,
        secret: body.secret,
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/subscriptions",
    tags: ["webhooks"],
    body: CreateBody,
    response: SubscriptionSchema,
    success: { status: 201, description: "Created" },
    toInput: ({ json }) => json as CreateInput,
    toBody: serialize,
  },
});

export const updateSubscriptionOperation = defineOperation<UpdateInput, SubscriptionRow>({
  id: "subscription.update",
  summary: "Update a subscription",
  permission: "subscription:write",
  resource: SUBSCRIPTION_RESOURCE,
  effect: "write",
  audit: AuditAction.SUBSCRIPTION_UPDATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const row = await updateSubscription(
      {
        tenant_id: scope.tenant_id,
        id,
        actor_id: principal.id,
        actor: actorOf(principal),
        ...(body.event_pattern !== undefined ? { event_pattern: body.event_pattern } : {}),
        ...(body.target_url !== undefined ? { target_url: body.target_url } : {}),
        ...(body.secret !== undefined ? { secret: body.secret } : {}),
        ...(body.rotating_secret !== undefined ? { rotating_secret: body.rotating_secret } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      scope.db,
    );
    return row ?? reject.notFound("subscription");
  },
  http: {
    method: "patch",
    path: "/v1/subscriptions/{id}",
    tags: ["webhooks"],
    params: IdParam,
    body: UpdateBody,
    response: SubscriptionSchema,
    errors: { 404: "Not found" },
    toInput: ({ param, json }) => ({ ...idFrom(param), body: json as UpdateFields }),
    toBody: serialize,
  },
});

export const deleteSubscriptionOperation = defineOperation<IdInput, { deleted: true }>({
  id: "subscription.delete",
  summary: "Delete a subscription",
  permission: "subscription:delete",
  resource: SUBSCRIPTION_RESOURCE,
  effect: "write",
  audit: AuditAction.SUBSCRIPTION_DELETED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const ok = await deleteSubscription(scope.tenant_id, id, actorOf(principal), scope.db);
    return ok ? { deleted: true } : reject.notFound("subscription");
  },
  http: {
    method: "delete",
    path: "/v1/subscriptions/{id}",
    tags: ["webhooks"],
    params: IdParam,
    response: z.object({ deleted: z.boolean() }),
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (result) => result,
  },
});

export const replaySubscriptionDeliveryOperation = defineOperation<ReplayInput, { replayed: true }>(
  {
    id: "subscription.replay_delivery",
    summary: "Replay a failed delivery",
    permission: "subscription:replay",
    resource: SUBSCRIPTION_RESOURCE,
    effect: "write",
    audit: AuditAction.WEBHOOK_OUTBOUND_REPLAYED,
    async handler(scope, input) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const boss = scope.boss;
      const replayed = await replayDelivery(scope.db, () => boss ?? getBoss(), principal, {
        subscription_id: input.id,
        delivery_id: input.delivery_id,
      });
      return replayed ? { replayed: true } : reject.notFound("delivery");
    },
    http: {
      method: "post",
      path: "/v1/subscriptions/{id}/deliveries/{delivery_id}/replay",
      tags: ["webhooks"],
      params: ReplayParams,
      response: z.object({ replayed: z.boolean() }),
      success: { status: 202, description: "Accepted" },
      errors: { 404: "Not found" },
      toInput: ({ param }) => param as ReplayInput,
      toBody: (result) => result,
    },
  },
);
