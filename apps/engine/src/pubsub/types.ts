// Types shared by the listener and the in-process pub/sub emitter.

import type { OutboxChannel } from "../db/events.ts";

export type { OutboxChannel };

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
