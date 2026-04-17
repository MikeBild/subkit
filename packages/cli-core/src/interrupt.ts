// Two-phase Ctrl+C interrupt helper. First press sends a cancel
// signal to the running conversation (`POST /v1/conversations/:id/
// cancel`); second press within `windowMs` exits the process.
// Outside a turn the helper returns `"exit"` immediately so the host
// CLI can tear down its readline / Ink runtime.
//
// This mirrors Claude Code's interrupt ceremony at minimal size.

export type InterruptPhase = "cancel-turn" | "exit";

export interface InterruptController {
  /**
   * Call on each Ctrl+C press. Pass `inTurn=true` if the conversation
   * loop is currently awaiting a frame; `false` when idle.
   */
  press(inTurn: boolean): InterruptPhase;
  /** Reset the internal timer (call when a new turn starts). */
  reset(): void;
}

export function makeInterruptController(windowMs = 2000): InterruptController {
  let lastCancelAt: number | null = null;
  return {
    press(inTurn: boolean): InterruptPhase {
      const now = Date.now();
      if (!inTurn) {
        lastCancelAt = null;
        return "exit";
      }
      if (lastCancelAt !== null && now - lastCancelAt <= windowMs) {
        lastCancelAt = null;
        return "exit";
      }
      lastCancelAt = now;
      return "cancel-turn";
    },
    reset(): void {
      lastCancelAt = null;
    },
  };
}
