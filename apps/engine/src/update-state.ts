// Module-scoped update state for the engine.
// The startup code writes to this; the health route reads from it.

export interface EngineUpdateState {
  update_available: boolean;
  latest_version: string;
}

let state: EngineUpdateState | null = null;

export function setUpdateState(s: EngineUpdateState): void {
  state = s;
}

export function getUpdateState(): EngineUpdateState | null {
  return state;
}

export function resetUpdateState(): void {
  state = null;
}
