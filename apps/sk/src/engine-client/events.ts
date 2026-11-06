import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type Subscription = Schemas["Subscription"];
type SubscriptionList = Schemas["SubscriptionListResponse"];
type SubscriptionDeliveryList = Schemas["SubscriptionDeliveryListResponse"];
export type SubscriptionDeliveriesQuery = ApiQuery<"/v1/subscriptions/{id}/deliveries", "get">;
export type CreateSubscriptionBody = Schemas["CreateSubscriptionBody"];
export type UpdateSubscriptionBody = Schemas["UpdateSubscriptionBody"];
export type WebhookInbound = Schemas["WebhookInbound"];
export type CreateWebhookInboundBody = Schemas["CreateWebhookInboundBody"];
export type NotificationChannel = Schemas["NotificationChannel"];
export type CreateNotificationChannelBody = Schemas["CreateNotificationChannelBody"];
export type UpdateNotificationChannelBody = Schemas["UpdateNotificationChannelBody"];
export type NotificationRule = Schemas["NotificationRule"];
export type CreateNotificationRuleBody = Schemas["CreateNotificationRuleBody"];
export type UpdateNotificationRuleBody = Schemas["UpdateNotificationRuleBody"];
export type NotificationSeverity = NonNullable<CreateNotificationRuleBody["severity"]>;
export type NotificationInboxQuery = ApiQuery<"/v1/notifications/inbox", "get">;

export const eventsMethods = {
  async listHooksInbound(this: EngineClient): Promise<Schemas["WebhookInboundListResponse"]> {
    const { data } = await this.api.GET("/v1/webhooks/inbound");
    return data as Schemas["WebhookInboundListResponse"];
  },
  async getHookInbound(this: EngineClient, id: string): Promise<WebhookInbound> {
    const { data } = await this.api.GET("/v1/webhooks/inbound/{id}", { params: { path: { id } } });
    return data as WebhookInbound;
  },
  async createHookInbound(
    this: EngineClient,
    body: CreateWebhookInboundBody,
  ): Promise<WebhookInbound> {
    const { data } = await this.api.POST("/v1/webhooks/inbound", { body });
    return data as WebhookInbound;
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
  async listSubscriptionDeliveries(
    this: EngineClient,
    id: string,
    query: SubscriptionDeliveriesQuery = {},
  ): Promise<SubscriptionDeliveryList> {
    const { data } = await this.api.GET("/v1/subscriptions/{id}/deliveries", {
      params: { path: { id }, query },
    });
    return data as SubscriptionDeliveryList;
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

  async listNotificationChannels(
    this: EngineClient,
  ): Promise<Schemas["NotificationChannelListResponse"]> {
    const { data } = await this.api.GET("/v1/notifications/channels");
    return data as Schemas["NotificationChannelListResponse"];
  },
  async createNotificationChannel(
    this: EngineClient,
    body: CreateNotificationChannelBody,
  ): Promise<NotificationChannel> {
    const { data } = await this.api.POST("/v1/notifications/channels", { body });
    return data as NotificationChannel;
  },
  async patchNotificationChannel(
    this: EngineClient,
    id: string,
    body: UpdateNotificationChannelBody,
  ): Promise<NotificationChannel> {
    const { data } = await this.api.PATCH("/v1/notifications/channels/{id}", {
      params: { path: { id } },
      body,
    });
    return data as NotificationChannel;
  },
  async deleteNotificationChannel(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/notifications/channels/{id}", { params: { path: { id } } });
  },
  async listNotificationRules(
    this: EngineClient,
  ): Promise<Schemas["NotificationRuleListResponse"]> {
    const { data } = await this.api.GET("/v1/notifications/rules");
    return data as Schemas["NotificationRuleListResponse"];
  },
  async createNotificationRule(
    this: EngineClient,
    body: CreateNotificationRuleBody,
  ): Promise<NotificationRule> {
    const { data } = await this.api.POST("/v1/notifications/rules", { body });
    return data as NotificationRule;
  },
  async patchNotificationRule(
    this: EngineClient,
    id: string,
    body: UpdateNotificationRuleBody,
  ): Promise<NotificationRule> {
    const { data } = await this.api.PATCH("/v1/notifications/rules/{id}", {
      params: { path: { id } },
      body,
    });
    return data as NotificationRule;
  },
  async deleteNotificationRule(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/notifications/rules/{id}", { params: { path: { id } } });
  },
  async listNotificationDeliveries(
    this: EngineClient,
    query: ApiQuery<"/v1/notifications/deliveries", "get"> = {},
  ): Promise<Schemas["NotificationDeliveryListResponse"]> {
    const { data } = await this.api.GET("/v1/notifications/deliveries", { params: { query } });
    return data as Schemas["NotificationDeliveryListResponse"];
  },
  async getNotificationInbox(
    this: EngineClient,
    query: NotificationInboxQuery = {},
  ): Promise<Schemas["CliNotificationInboxListResponse"]> {
    const { data } = await this.api.GET("/v1/notifications/inbox", { params: { query } });
    return data as Schemas["CliNotificationInboxListResponse"];
  },
  async ackNotificationInbox(
    this: EngineClient,
    up_to_cursor: number,
  ): Promise<Schemas["CliNotificationInboxAckResponse"]> {
    const body: ApiBody<"/v1/notifications/inbox/ack", "post"> = { up_to_cursor };
    const { data } = await this.api.POST("/v1/notifications/inbox/ack", { body });
    return data as Schemas["CliNotificationInboxAckResponse"];
  },
  async markNotificationInboxRead(
    this: EngineClient,
    ids: number[],
  ): Promise<Schemas["CliNotificationInboxMarkReadResponse"]> {
    const { data } = await this.api.POST("/v1/notifications/inbox/read", { body: { ids } });
    return data as Schemas["CliNotificationInboxMarkReadResponse"];
  },
  async markNotificationInboxUnread(
    this: EngineClient,
    ids: number[],
  ): Promise<Schemas["CliNotificationInboxMarkUnreadResponse"]> {
    const { data } = await this.api.POST("/v1/notifications/inbox/unread", { body: { ids } });
    return data as Schemas["CliNotificationInboxMarkUnreadResponse"];
  },
};
