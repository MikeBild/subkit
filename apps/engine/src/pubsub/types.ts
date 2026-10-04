import { z } from "zod";
import type { OutboxChannel } from "../db/events.ts";

export type { OutboxChannel };

export const WorkflowLifecyclePayloadSchema = z.object({
  workflow_id: z.string().uuid(),
  actor_id: z.string().uuid().nullable(),
  slug: z.string().min(1).optional(),
  version: z.number().int().positive().optional(),
  lifecycle: z.enum(["draft", "active", "archived"]).optional(),
  restored_from: z.number().int().positive().optional(),
  new_version: z.number().int().positive().optional(),
});

export type WorkflowLifecyclePayload = z.infer<typeof WorkflowLifecyclePayloadSchema>;

export const ConnectorOauthCallbackPayloadSchema = z.object({
  connector_id: z.string().uuid(),
  connector_slug: z.string().min(1),
  has_refresh_token: z.boolean(),
  source: z.literal("oauth_callback"),
});

export type ConnectorOauthCallbackPayload = z.infer<typeof ConnectorOauthCallbackPayloadSchema>;

export const ConnectorOauthCallbackFailedReasons = [
  "provider_error",
  "missing_code",
  "token_exchange_failed",
] as const;

export const ConnectorOauthCallbackFailedPayloadSchema = z.object({
  connector_id: z.string().uuid(),
  connector_slug: z.string().min(1),
  reason: z.enum(ConnectorOauthCallbackFailedReasons),
});

export type ConnectorOauthCallbackFailedPayload = z.infer<
  typeof ConnectorOauthCallbackFailedPayloadSchema
>;

export const ConnectorAuthFailedPayloadSchema = z.object({
  severity: z.literal("error"),
  workflow_id: z.string().uuid().nullable(),
  connector_id: z.string().uuid(),
  connector_slug: z.string().min(1),
  reason: z.string(),
  reauth_url: z.string().nullable(),
});

export type ConnectorAuthFailedPayload = z.infer<typeof ConnectorAuthFailedPayloadSchema>;

export const ConnectorHealthChangedPayloadSchema = z.object({
  severity: z.enum(["error", "warn"]),
  workflow_id: z.string().uuid().nullable(),
  connector_id: z.string().uuid(),
  connector_slug: z.string().min(1),
  from_state: z.string().min(1),
  to_state: z.enum(["ok", "degraded", "needs_update", "needs_reauth"]),
  error_code: z.string().nullable(),
  reason: z.string(),
  sunset_at: z.string().nullable(),
  successor_uri: z.string().nullable(),
});

export type ConnectorHealthChangedPayload = z.infer<typeof ConnectorHealthChangedPayloadSchema>;

export const LISTENER_CHANNELS = [
  "execution.status",
  "workflow.chain",
  "workflow.lifecycle",
  "skill.lifecycle",
  "connector.oauth",
  "conversation.stream",
  "event.emitted",
  "notification.emitted",
  "resource.lifecycle",
] as const satisfies readonly OutboxChannel[];

export interface EventEnvelope<P = unknown> {
  id: number;
  tenant_id: string;
  channel: OutboxChannel;
  type: string;
  payload: P;
  created_at: Date;
}

export type EventHandler<P = unknown> = (event: EventEnvelope<P>) => void | Promise<void>;
