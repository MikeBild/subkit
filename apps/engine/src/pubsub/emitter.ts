// Thin typed pub/sub emitter used by the listener to fan events out to
// local subscribers. Not exposed over the wire — consumers in the same
// process register handlers via `pubsub.on(channel, handler)` and the
// listener calls `dispatch(envelope)` once the row has been hydrated.
//
// Durability contract:
//
//   The emitter holds in-process subscriber state ONLY. It is intentionally
//   not durable across process restarts — every consumer that needs to
//   pick up where it left off after a crash MUST persist its checkpoint
//   to Postgres (see `pubsub/listener.ts` — it tracks `outboxCursors`
//   per channel + listener so a fresh process re-reads from the cursor
//   on boot rather than from in-memory state).
//
//   Operators relying on the emitter for cross-process delivery should
//   restart the engine in tandem with any consumer process; otherwise
//   handlers registered against the previous process are simply gone.
//
// State growth is bounded: handlers.size grows only when callers
// register and shrinks on `off()` or `clear()`. There is no key
// cardinality risk (channels are a closed enum).

import { logger } from "../logging/logger.ts";
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

// Default shared emitter used by the engine's global listener.
export const globalEmitter = new PubSubEmitter();
