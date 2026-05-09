// Types shared by the listener and the in-process pub/sub emitter.

import type { OutboxChannel } from "../db/events.ts";

export type { OutboxChannel };

export const LISTENER_CHANNELS: OutboxChannel[] = [
  "execution.status",
  "workflow.chain",
  "connector.oauth",
  "conversation.stream",
  "event.emitted",
  "notification.emitted",
];

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
