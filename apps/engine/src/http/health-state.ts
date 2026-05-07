// Module-scoped health state for the engine.
//
// Boot-time code (apps/engine/src/index.ts) writes here; the
// /v1/health route reads from it. A single record-typed accessor
// keeps the boot path's mutation surface compact: each new flag is
// one new field rather than another import + setter pair, and the
// test reset surface stays one call.

export interface EngineHealthState {
  /**
   * `true` when the boot path observed migration rows on this DB
   * whose hash isn't in this binary's embedded set — i.e. the schema
   * state was set by a different engine lineage. Surfaced in
   * `/v1/health` as `db_schema_drift` so operators see the alarm on
   * the dashboard rather than scanning logs (issue #149 / W2 follow-up).
   */
  schema_drift: boolean;
}

const INITIAL: EngineHealthState = {
  schema_drift: false,
};

let _state: EngineHealthState = { ...INITIAL };

/** Patch one or more health-state fields at once. Boot-time only. */
export function setHealthState(patch: Partial<EngineHealthState>): void {
  _state = { ..._state, ...patch };
}

/** Read the current snapshot. Returned object is frozen so callers
 *  can't mutate the singleton by reference. */
export function getHealthState(): Readonly<EngineHealthState> {
  return _state;
}

/** Test-only reset. */
export function resetHealthState(): void {
  _state = { ...INITIAL };
}
