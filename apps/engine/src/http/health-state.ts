export interface EngineHealthState {
  schema_drift: boolean;

  draining: boolean;
}

const INITIAL: EngineHealthState = {
  schema_drift: false,
  draining: false,
};

let _state: EngineHealthState = { ...INITIAL };

export function setHealthState(patch: Partial<EngineHealthState>): void {
  _state = { ..._state, ...patch };
}

export function getHealthState(): Readonly<EngineHealthState> {
  return _state;
}
