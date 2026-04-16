// Turn an in-progress conversation loop run into an AsyncIterable
// of `TurnEvent` frames for the SSE route.
//
// v1 strategy: run the loop to completion up-front, then yield the
// cached event list. This matches the rest of the P10 surface where
// the loop is deterministic and bounded, and keeps the HTTP route
// implementation dead simple. A later phase can swap in a push-based
// EventEmitter when the real streaming SDK lands.

import type { RunLoopResult } from "./loop.ts";
import type { TurnEvent } from "./types.ts";

export async function* replayEvents(result: RunLoopResult): AsyncIterable<TurnEvent> {
  for (const ev of result.events) {
    yield ev;
  }
}

export function serializeEvent(ev: TurnEvent): { event: string; data: string } {
  return { event: ev.type, data: JSON.stringify(ev) };
}
