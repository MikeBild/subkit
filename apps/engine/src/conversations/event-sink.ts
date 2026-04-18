// EventSink — pluggable emission channel for the conversation loop.
//
// The loop historically pushed TurnEvents into a bare array and let the
// HTTP route iterate after completion. That's replay, not streaming.
// This sink wraps the array and invokes an optional live emitter on
// every push so the SSE / MCP / Ink surfaces can render frames as they
// happen without losing the buffered-for-replay semantics that tests
// and the persistence layer still rely on.

import type { TurnEvent } from "./types.ts";

export type TurnEventEmitter = (ev: TurnEvent) => void;

export class EventSink {
  public readonly events: TurnEvent[] = [];
  private readonly emitter: TurnEventEmitter | undefined;

  constructor(emitter?: TurnEventEmitter) {
    this.emitter = emitter;
  }

  push(ev: TurnEvent): void {
    this.events.push(ev);
    // Best-effort live emission. Emitter errors never block the loop.
    if (this.emitter) {
      try {
        this.emitter(ev);
      } catch {
        // Swallow — the buffered replay stays valid.
      }
    }
  }

  /**
   * Ergonomic compatibility layer for call-sites that used to do
   * `events.push(x)`. Returns the internal array so legacy code can
   * continue to read / iterate it; writes continue to flow through
   * the emitter. Prefer `sink.push(ev)` for new code.
   */
  asArrayProxy(): TurnEvent[] {
    const sink = this;
    return new Proxy(this.events, {
      get(target, key, receiver) {
        if (key === "push") {
          return (...args: TurnEvent[]) => {
            for (const ev of args) sink.push(ev);
            return target.length;
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
  }
}
