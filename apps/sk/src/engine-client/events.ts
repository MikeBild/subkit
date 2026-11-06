import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export type Subscription = components["schemas"]["Subscription"];
type SubscriptionList = components["schemas"]["SubscriptionListResponse"];
export type CreateSubscriptionBody = components["schemas"]["CreateSubscriptionBody"];
export type UpdateSubscriptionBody = components["schemas"]["UpdateSubscriptionBody"];

export const eventsMethods = {
  async listHooksInbound(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/webhooks/inbound");
    return data as { items: Record<string, unknown>[] };
  },
  async getHookInbound(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/webhooks/inbound/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async createHookInbound(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/webhooks/inbound", {
      body: body as ApiBody<"/v1/webhooks/inbound", "post">,
    });
    return data as Record<string, unknown>;
  },
  async deleteHookInbound(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/webhooks/inbound/{id}", { params: { path: { id } } });
  },

  async listSubscriptions(this: EngineClient): Promise<SubscriptionList> {
    const { data } = await this.api.GET("/v1/subscriptions");
    return data as SubscriptionList;
  },
  async getSubscription(this: EngineClient, id: string): Promise<Subscription> {
    const { data } = await this.api.GET("/v1/subscriptions/{id}", { params: { path: { id } } });
    return data as Subscription;
  },
  async createSubscription(
    this: EngineClient,
    body: CreateSubscriptionBody,
  ): Promise<Subscription> {
    const { data } = await this.api.POST("/v1/subscriptions", { body });
    return data as Subscription;
  },
  async patchSubscription(
    this: EngineClient,
    id: string,
    body: UpdateSubscriptionBody,
  ): Promise<Subscription> {
    const { data } = await this.api.PATCH("/v1/subscriptions/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Subscription;
  },
  async deleteSubscription(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/subscriptions/{id}", { params: { path: { id } } });
  },
  async replaySubscriptionDelivery(
    this: EngineClient,
    id: string,
    deliveryId: string,
  ): Promise<{ replayed: boolean }> {
    const { data } = await this.api.POST("/v1/subscriptions/{id}/deliveries/{delivery_id}/replay", {
      params: { path: { id, delivery_id: deliveryId } },
    });
    return data as { replayed: boolean };
  },

  async listEvents(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/events", {
      params: { query: query as ApiQuery<"/v1/events", "get"> },
    });
    return data as { items: Record<string, unknown>[] };
  },

  async listNotificationChannels(
    this: EngineClient,
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/notifications/channels");
    return data as { items: Record<string, unknown>[] };
  },
  async createNotificationChannel(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/notifications/channels", {
      body: body as ApiBody<"/v1/notifications/channels", "post">,
    });
    return data as Record<string, unknown>;
  },
  async patchNotificationChannel(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/notifications/channels/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/notifications/channels/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async deleteNotificationChannel(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/notifications/channels/{id}", { params: { path: { id } } });
  },
  async listNotificationRules(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/notifications/rules");
    return data as { items: Record<string, unknown>[] };
  },
  async createNotificationRule(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/notifications/rules", {
      body: body as ApiBody<"/v1/notifications/rules", "post">,
    });
    return data as Record<string, unknown>;
  },
  async patchNotificationRule(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/notifications/rules/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/notifications/rules/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async deleteNotificationRule(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/notifications/rules/{id}", { params: { path: { id } } });
  },
  async listNotificationDeliveries(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/notifications/deliveries", {
      params: { query: query as ApiQuery<"/v1/notifications/deliveries", "get"> },
    });
    return data as { items: Record<string, unknown>[] };
  },
  getNotificationInbox(
    this: EngineClient,
    query: {
      since?: number;
      limit?: number;
      unread_only?: boolean;
      actionable_only?: boolean;
    } = {},
  ): Promise<{
    items: Array<{
      id: number;
      severity: string;
      event_type: string;
      event_payload: unknown;
      actionable: boolean;
      resource_type: string | null;
      resource_id: string | null;
      read: boolean;
      read_at: string | null;
      created_at: string;
    }>;
    cursor: number;
    unread_count: number;
    actionable_unread_count: number;
  }> {
    return this.request("GET", "/v1/notifications/inbox", undefined, {
      since: query.since,
      limit: query.limit,
      unread_only: query.unread_only,
      actionable_only: query.actionable_only,
    });
  },
  async ackNotificationInbox(this: EngineClient, up_to_cursor: number): Promise<{ acked: number }> {
    const { data } = await this.api.POST("/v1/notifications/inbox/ack", {
      body: { up_to_cursor } as ApiBody<"/v1/notifications/inbox/ack", "post">,
    });
    return data as { acked: number };
  },
  async markNotificationInboxRead(this: EngineClient, ids: number[]): Promise<{ marked: number }> {
    const { data } = await this.api.POST("/v1/notifications/inbox/read", {
      body: { ids } as ApiBody<"/v1/notifications/inbox/read", "post">,
    });
    return data as { marked: number };
  },
  async markNotificationInboxUnread(
    this: EngineClient,
    ids: number[],
  ): Promise<{ unmarked: number }> {
    const { data } = await this.api.POST("/v1/notifications/inbox/unread", {
      body: { ids } as ApiBody<"/v1/notifications/inbox/unread", "post">,
    });
    return data as { unmarked: number };
  },
};
