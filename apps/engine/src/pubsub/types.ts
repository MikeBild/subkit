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
