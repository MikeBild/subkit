export type AwakeEvent =
  | { type: "step_started"; command_id: string }
  | { type: "step_ended"; command_id: string }
  | { type: "task_started"; session_id: string }
  | { type: "task_ended" }
  | { type: "runner_ended" };

export interface AwakeState {
  readonly holds: ReadonlySet<string>;
}

export type AwakeChange = "start" | "stop" | null;

export const NOT_HOLDING: AwakeState = { holds: new Set() };

const TASK_HOLD = "task:";

function withHold(state: AwakeState, hold: string): AwakeState {
  if (state.holds.has(hold)) return state;
  return { holds: new Set([...state.holds, hold]) };
}

function without(state: AwakeState, drop: (hold: string) => boolean): AwakeState {
  const kept = [...state.holds].filter((hold) => !drop(hold));
  if (kept.length === state.holds.size) return state;
  return kept.length === 0 ? NOT_HOLDING : { holds: new Set(kept) };
}

export function awakeNext(state: AwakeState, event: AwakeEvent): AwakeState {
  switch (event.type) {
    case "step_started":
      return withHold(state, `step:${event.command_id}`);
    case "step_ended":
      return without(state, (hold) => hold === `step:${event.command_id}`);
    case "task_started":
      return withHold(state, `${TASK_HOLD}${event.session_id}`);
    case "task_ended":
      return without(state, (hold) => hold.startsWith(TASK_HOLD));
    case "runner_ended":
      return without(state, () => true);
  }
}

export function awakeChange(before: AwakeState, after: AwakeState): AwakeChange {
  if (before.holds.size === 0 && after.holds.size > 0) return "start";
  if (before.holds.size > 0 && after.holds.size === 0) return "stop";
  return null;
}
