import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

export type Subscription = components["schemas"]["Subscription"];
export type SubscriptionList = components["schemas"]["SubscriptionListResponse"];
export type CreateSubscriptionBody = components["schemas"]["CreateSubscriptionBody"];
export type UpdateSubscriptionBody = components["schemas"]["UpdateSubscriptionBody"];

export const eventsMethods = {
  listHooksInbound(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/webhooks/inbound");
  },
  getHookInbound(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/webhooks/inbound/${encodeURIComponent(id)}`);
  },
  createHookInbound(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/webhooks/inbound", body);
  },
  deleteHookInbound(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/webhooks/inbound/${encodeURIComponent(id)}`);
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

  listEvents(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/events", undefined, query);
  },

  listNotificationChannels(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/notifications/channels");
  },
  createNotificationChannel(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/notifications/channels", body);
  },
  patchNotificationChannel(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/notifications/channels/${encodeURIComponent(id)}`, body);
  },
  deleteNotificationChannel(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/notifications/channels/${encodeURIComponent(id)}`);
  },
  listNotificationRules(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/notifications/rules");
  },
  createNotificationRule(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/notifications/rules", body);
  },
  patchNotificationRule(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/notifications/rules/${encodeURIComponent(id)}`, body);
  },
  deleteNotificationRule(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/notifications/rules/${encodeURIComponent(id)}`);
  },
  listNotificationDeliveries(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/notifications/deliveries", undefined, query);
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
  ackNotificationInbox(this: EngineClient, up_to_cursor: number): Promise<{ acked: number }> {
    return this.request("POST", "/v1/notifications/inbox/ack", { up_to_cursor });
  },
  markNotificationInboxRead(this: EngineClient, ids: number[]): Promise<{ marked: number }> {
    return this.request("POST", "/v1/notifications/inbox/read", { ids });
  },
  markNotificationInboxUnread(this: EngineClient, ids: number[]): Promise<{ unmarked: number }> {
    return this.request("POST", "/v1/notifications/inbox/unread", { ids });
  },
};
