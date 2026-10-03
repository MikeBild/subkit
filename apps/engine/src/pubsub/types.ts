// Types shared by the listener and the in-process pub/sub emitter.

import { z } from "zod";
import type { OutboxChannel } from "../db/events.ts";

export type { OutboxChannel };

/**
 * Payload contract for the `workflow.lifecycle` channel.
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
 * Mirrors `ConnectorOauthCallbackPayloadSchema` — including
 * `connector_slug`. `connector.oauth.callback_failed` is a published
 * webhook event (see `webhooks/events/catalog.ts`); a consumer correlating
 * success/failure pairs must see the slug on BOTH or it loses the
 * correlation key on failure. The slug is sourced via one connector lookup
 * on the failure path.
 *
 * Field semantics:
 *   - `connector_id`   — the connector whose OAuth dance failed.
 *   - `connector_slug` — operator-friendly slug; mirrors the connectors
 *                        row so webhook/log readers don't have to resolve
 *                        UUIDs, and so it pairs with the success event.
 *   - `reason`         — a short sanitized failure token from a fixed
 *                        allowlist. It must NEVER carry raw provider error
 *                        text or a token-exchange exception message: those
 *                        can embed request fragments (state tokens,
 *                        redirect URIs) and this event is broadcast over
 *                        pub/sub and exposed via the webhook catalog. The
 *                        verbose original error stays in the structured
 *                        `logger` call only.
 */
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

/**
 * Payload contract for `connector.auth_failed` on the
 * `notification.emitted` channel. Emitted on the false→true edge of
 * `connectors.needs_reauth` (see `connectors/reauth.ts`).
 *
 * Lives here rather than in `webhooks/events/catalog.ts` so the emitter can
 * parse against it without `connectors/` → `webhooks/` → `pubsub/` import
 * cycle; the catalog re-exports it as the published event schema.
 *
 * Field semantics:
 *   - `severity`     — pinned to `"error"`; the fanout's severity extractor
 *                      reads this key off the payload.
 *   - `workflow_id`  — `null` when the failure is not workflow-scoped; the
 *                      fanout's workflow extractor reads this key.
 *   - `reason`       — short failure token recorded on `auth_failed_reason`.
 *   - `reauth_url`   — stable reconnect endpoint, `null` when no public
 *                      engine origin resolves.
 */
export const ConnectorAuthFailedPayloadSchema = z.object({
  severity: z.literal("error"),
  workflow_id: z.string().uuid().nullable(),
  connector_id: z.string().uuid(),
  connector_slug: z.string().min(1),
  reason: z.string(),
  reauth_url: z.string().nullable(),
});

export type ConnectorAuthFailedPayload = z.infer<typeof ConnectorAuthFailedPayloadSchema>;

/**
 * Payload contract for `connector.health_changed` on the
 * `notification.emitted` channel. Emitted on a `connectors.health_state`
 * transition edge (see `connectors/health-state.ts`).
 *
 * `to_state` carries the full `ConnectorHealthState` vocabulary rather than
 * only the degradation states: the emitter's parameter type is that union,
 * so narrowing here would encode the caller's `state !== "ok"` guard in a
 * second place. The emitter builds a `ConnectorHealthChangedPayload`-typed
 * object, so a state added to the domain union but not to this enum fails
 * to compile.
 *
 *   - `severity`     — `"error"` for a removed endpoint, `"warn"` otherwise.
 *   - `from_state`   — previous `health_state` as stored (free-form string:
 *                      it is read back from SQL, not from the union).
 *   - `error_code`   — stable machine code (`endpoint_removed`,
 *                      `endpoint_deprecated`, …) or `null`.
 *   - `sunset_at`    — vendor-announced removal date (ISO) or `null`.
 */
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

/**
 * Channels the listener fans out to in-process subscribers. The literal
 * list is `satisfies`-typed against `readonly OutboxChannel[]` so the
 * compiler rejects any drift from the union in `db/events.ts` — a
 * channel added there but missing here (or vice versa) is a compile
 * error, not a silent runtime gap.
 */
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
