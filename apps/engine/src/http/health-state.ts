// Module-scoped health state for the engine.
//
// Boot-time code (apps/engine/src/index.ts) writes here; the
// /health route reads from it. A single record-typed accessor
// keeps the boot path's mutation surface compact: each new flag is
// one new field rather than another import + setter pair, and the
// test reset surface stays one call.

export interface EngineHealthState {
  /**
   * `true` when the boot path observed a tagged migration identity
   * unknown to this binary or a missing embedded identity. Surfaced in
   * `/v1/diagnostics/version` (gated by `audit:read`) so operators see
   * the alarm without leaking it to unauthenticated callers.
   */
  schema_drift: boolean;

  /**
   * `true` once the process has begun graceful shutdown. Flipped at the
   * top of `shutdown()` (apps/engine/src/index.ts) BEFORE the HTTP server
   * stops accepting connections, so `/ready` returns 503 and the load
   * balancer / systemd health gate stops routing to this instance while
   * in-flight `conversation.run-turn` jobs drain. Deliberately NOT surfaced
   * on `/health` (that route must not leak operational posture).
   */
  draining: boolean;
}

const INITIAL: EngineHealthState = {
  schema_drift: false,
  draining: false,
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
