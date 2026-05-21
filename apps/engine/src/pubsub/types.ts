// Types shared by the listener and the in-process pub/sub emitter.

import { z } from "zod";
import type { OutboxChannel } from "../db/events.ts";

export type { OutboxChannel };

/**
 * Payload contract for the `workflow.lifecycle` channel (#178 round-3 S1).
 *
 * Every state-changing entry point in `workflows/service.ts` emits via
 * `writeEvent(tx, { channel: "workflow.lifecycle", type, payload })` and
 * MUST parse its payload through this schema first so the channel has
 * the same Zod-at-boundary discipline as an HTTP route.
 *
 * Single flat shape with optional fields rather than a discriminated
 * union — each call site already passes the outer `type` to
 * `writeEvent`, and the only subscriber today (the MCP forwarder)
 * reads `workflow_id` plus the outer `type`. A discriminated union
 * here would duplicate the discriminator without buying type-safety
 * on the consumer.
 *
 * Field semantics:
 *   - `workflow_id`   — always present.
 *   - `actor_id`      — always present (`null` when the system).
 *   - `slug`          — present on every event except
 *                       `workflow.version_restored` (audit captures it).
 *   - `version`       — current/new version after a definition change.
 *                       Absent on `workflow.metadata_updated` (no new
 *                       version row) and `workflow.deleted`.
 *   - `lifecycle`     — only on `workflow.metadata_updated`.
 *   - `restored_from` / `new_version` — only on `workflow.version_restored`.
 */
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

/**
 * Payload contract for `connector.oauth.callback_succeeded` events on
 * the `connector.oauth` channel. Emitted exactly once per successful
 * OAuth authorization-code dance from the callback route
 * (`apps/engine/src/http/routes/connectors/oauth.ts`).
 *
 * Subscribers:
 *   - sk-cli listens via `/v1/events/stream?channel=connector.oauth&type=connector.oauth.callback_succeeded`
 *     so the in-progress conversation can auto-resume once the user
 *     completes the OAuth flow in their browser — no manual "done"
 *     type-back required (Fix #1, plan/read-sk-synthetic-wirth.md).
 *
 * Field semantics:
 *   - `connector_id`      — the connector whose credential was just written.
 *   - `connector_slug`    — operator-friendly slug; mirrors the connectors
 *                           row so log readers don't have to resolve UUIDs.
 *   - `has_refresh_token` — true when the provider returned a refresh
 *                           token, which gates whether the background
 *                           refresh worker will run.
 *   - `source`            — provenance tag mirroring the credentials row
 *                           (`"oauth_callback"` from this path; future
 *                           sources may include `"refresh_worker"`).
 */
export const ConnectorOauthCallbackPayloadSchema = z.object({
  connector_id: z.string().uuid(),
  connector_slug: z.string().min(1),
  has_refresh_token: z.boolean(),
  source: z.literal("oauth_callback"),
});

export type ConnectorOauthCallbackPayload = z.infer<typeof ConnectorOauthCallbackPayloadSchema>;

/**
 * Payload contract for `connector.oauth.callback_failed` events on the
 * `connector.oauth` channel. Emitted from the callback route's failure
 * branches (provider error, missing code, token-exchange failure) when
 * a state row was claimed — so a tenant + connector scope is available.
 *
 * Mirrors `ConnectorOauthCallbackPayloadSchema` but carries no
 * `connector_slug`: the only consumer is `waitForOAuthCredential`, which
 * keys on `connector_id` alone. There is no SSE log-readability consumer
 * for the failed payload, so the slug is intentionally dropped.
 *
 * Field semantics:
 *   - `connector_id` — the connector whose OAuth dance failed.
 *   - `reason`       — short machine/human reason: the provider's
 *                      `error` code, `"missing_code"`, or the
 *                      token-exchange error message.
 */
export const ConnectorOauthCallbackFailedPayloadSchema = z.object({
  connector_id: z.string().uuid(),
  reason: z.string().min(1),
});

export type ConnectorOauthCallbackFailedPayload = z.infer<
  typeof ConnectorOauthCallbackFailedPayloadSchema
>;

/**
 * Channels the listener fans out to in-process subscribers. The literal
 * list is `satisfies`-typed against `readonly OutboxChannel[]` so the
 * compiler rejects any drift from the union in `db/events.ts` — a
 * channel added there but missing here (or vice versa) is a compile
 * error, not a silent runtime gap. Mirrors #178 review S-2.
 */
export const LISTENER_CHANNELS = [
  "execution.status",
  "workflow.chain",
  "workflow.lifecycle",
  "connector.oauth",
  "conversation.stream",
  "event.emitted",
  "notification.emitted",
] as const satisfies readonly OutboxChannel[];

/** Full event envelope delivered to local subscribers. */
export interface EventEnvelope<P = unknown> {
  id: number;
  tenant_id: string;
  channel: OutboxChannel;
  type: string;
  payload: P;
  created_at: Date;
}

export type EventHandler<P = unknown> = (event: EventEnvelope<P>) => void | Promise<void>;
