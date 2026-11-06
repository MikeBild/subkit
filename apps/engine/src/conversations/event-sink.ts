import type { TurnEvent } from "./types.ts";

type TurnEventEmitter = (ev: TurnEvent) => void;

const ACTIVITY_THROTTLE_MS = 200;

export class EventSink {
  public readonly events: TurnEvent[] = [];
  private readonly emitter: TurnEventEmitter | undefined;
  private lastActivityEmit = new Map<string, number>();

  constructor(emitter?: TurnEventEmitter) {
    this.emitter = emitter;
  }

  push(ev: TurnEvent): void {
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
    } catch {}
  }

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
