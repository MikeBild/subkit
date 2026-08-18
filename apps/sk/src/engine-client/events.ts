// Eventing surfaces of the engine client: inbound webhooks, outbound
// subscriptions + delivery replay, the tenant event feed, and
// notification channels / rules / deliveries / inbox. Method group
// merged into `EngineClient` by `../engine-client.ts`.

import type { EngineClient } from "../engine-client.ts";

export const eventsMethods = {
  // -------------------- Inbound Hooks --------------------
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

  // -------------------- Subscriptions --------------------
  listSubscriptions(this: EngineClient): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/subscriptions");
  },
  getSubscription(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
  },
  createSubscription(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/subscriptions", body);
  },
  patchSubscription(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/subscriptions/${encodeURIComponent(id)}`, body);
  },
  deleteSubscription(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`);
  },
  replaySubscriptionDelivery(
    this: EngineClient,
    id: string,
    deliveryId: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/subscriptions/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
    );
  },

  // -------------------- Events --------------------
  listEvents(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/events", undefined, query);
  },

  // -------------------- Notifications --------------------
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
