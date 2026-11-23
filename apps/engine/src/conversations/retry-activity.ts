import { MAX_CONSECUTIVE_FAILURES, type TurnSignals } from "./tools/sdk-wrap/state.ts";
import type { TurnEvent } from "./types.ts";

type ActivityRetry = { attempt: number; of: number };

export function toolRetry(
  signals: Pick<TurnSignals, "consecutiveFailures" | "toolLastErrorHash">,
  tool: string,
): { retry?: ActivityRetry } {
  const failures = signals.consecutiveFailures;
  if (failures < 1 || failures >= MAX_CONSECUTIVE_FAILURES) return {};
  if (!signals.toolLastErrorHash.has(tool)) return {};
  return { retry: { attempt: failures, of: MAX_CONSECUTIVE_FAILURES - 1 } };
}

export function fallbackRetryActivity(): TurnEvent {
  return {
    type: "activity",
    phase: "composing",
    label: "retrying with the fallback model",
    retry: { attempt: 1, of: 1 },
  };
}
