import {
  applyTurnEvent as reduceTurnEvent,
  type SkSessionState,
  type TurnEvent,
} from "./turn-event-model.ts";

export * from "./turn-event-model.ts";

export function applyTurnEvent(state: SkSessionState, event: TurnEvent): SkSessionState {
  return reduceTurnEvent(
    state,
    event,
    event.type === "activity" || event.type === "diff" ? Date.now() : 0,
  );
}
