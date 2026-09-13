// EventSink — pluggable emission channel for the conversation loop.
//
// The loop historically pushed TurnEvents into a bare array and let the
// HTTP route iterate after completion. That's replay, not streaming.
// This sink wraps the array and invokes an optional live emitter on
// every push so the SSE / MCP / Ink surfaces can render frames as they
// happen without losing the buffered-for-replay semantics that tests
// and the persistence layer still rely on.
//
// Activity-event coalescing: `activity` events are throttled to one
// emission per 200ms per (phase, label) pair. Pre-throttle a tool
// loop that calls `inspect_workflow` 5× in 50ms produced 5 activity
// frames over the wire; the CLI then re-rendered the ticker 5× in a
// blink, causing flicker. The throttle keeps the SSE channel quiet
// while still firing on meaningful transitions. Non-activity events
// pass through unmodified.

import type { TurnEvent } from "./types.ts";

export type TurnEventEmitter = (ev: TurnEvent) => void;

const ACTIVITY_THROTTLE_MS = 200;

export class EventSink {
  public readonly events: TurnEvent[] = [];
  private readonly emitter: TurnEventEmitter | undefined;
  /** Last emit timestamp keyed by `${phase}\0${label}`. */
  private lastActivityEmit = new Map<string, number>();

  constructor(emitter?: TurnEventEmitter) {
    this.emitter = emitter;
  }

  push(ev: TurnEvent): void {
    // Always buffer for replay regardless of throttling.
    this.events.push(ev);
    if (!this.emitter) return;

    if (ev.type === "activity") {
      const key = `${ev.phase}\0${ev.label}`;
      const now = Date.now();
      const last = this.lastActivityEmit.get(key);
      if (last !== undefined && now - last < ACTIVITY_THROTTLE_MS) return;
      this.lastActivityEmit.set(key, now);
    }

    try {
      this.emitter(ev);
    } catch {
      // Swallow — the buffered replay stays valid.
    }
  }

  /**
   * Ergonomic compatibility layer for call-sites that used to do
   * `events.push(x)`. Returns the internal array so legacy code can
   * continue to read / iterate it; writes continue to flow through
   * the emitter. Prefer `sink.push(ev)` for new code.
   */
  asArrayProxy(): TurnEvent[] {
    const push = this.push.bind(this);
    return new Proxy(this.events, {
      get(target, key, receiver) {
        if (key === "push") {
          return (...args: TurnEvent[]) => {
            for (const ev of args) push(ev);
            return target.length;
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
  }
}
