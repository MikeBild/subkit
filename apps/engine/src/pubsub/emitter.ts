import { logger } from "../logging/index.ts";
import type { EventEnvelope, EventHandler, OutboxChannel } from "./types.ts";

export class PubSubEmitter {
  private handlers: Map<OutboxChannel, Set<EventHandler>> = new Map();

  on<P = unknown>(channel: OutboxChannel, handler: EventHandler<P>): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler as EventHandler);
    return () => this.off(channel, handler);
  }

  off<P = unknown>(channel: OutboxChannel, handler: EventHandler<P>): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    set.delete(handler as EventHandler);
    if (set.size === 0) this.handlers.delete(channel);
  }

  listenerCount(channel?: OutboxChannel): number {
    if (!channel) {
      let total = 0;
      for (const set of this.handlers.values()) total += set.size;
      return total;
    }
    return this.handlers.get(channel)?.size ?? 0;
  }

  async dispatch<P = unknown>(event: EventEnvelope<P>): Promise<void> {
    const set = this.handlers.get(event.channel);
    if (!set || set.size === 0) return;
    const calls: Array<Promise<void> | void> = [];
    for (const handler of set) {
      try {
        calls.push(handler(event as EventEnvelope<unknown>));
      } catch (err) {
        logger.error({
          module: "pubsub",
          action: "handler.threw",
          msg: "pub/sub handler threw synchronously",
          channel: event.channel,
          event_id: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const results = await Promise.allSettled(calls as Array<Promise<void>>);
    for (const r of results) {
      if (r.status === "rejected") {
        logger.error({
          module: "pubsub",
          action: "handler.rejected",
          msg: "pub/sub handler rejected",
          channel: event.channel,
          event_id: event.id,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const globalEmitter = new PubSubEmitter();
