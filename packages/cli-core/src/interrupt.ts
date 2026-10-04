export type InterruptPhase = "cancel-turn" | "exit";

export interface InterruptController {
  press(inTurn: boolean): InterruptPhase;
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
