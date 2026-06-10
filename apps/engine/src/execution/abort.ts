// Process-local map: execution_id -> AbortController. POST
// /v1/executions/:id/cancel looks the controller up here and fires
// `abort('cancelled')`. The map is cleaned up automatically when the
// execution finishes.

const REGISTRY = new Map<string, AbortController>();

export function registerAbort(executionId: string): AbortController {
  const ctrl = new AbortController();
  REGISTRY.set(executionId, ctrl);
  return ctrl;
}

export function getAbort(executionId: string): AbortController | undefined {
  return REGISTRY.get(executionId);
}

export function unregisterAbort(executionId: string): void {
  REGISTRY.delete(executionId);
}

export function cancel(executionId: string, reason = "cancelled"): boolean {
  const ctrl = REGISTRY.get(executionId);
  if (!ctrl) return false;
  ctrl.abort(reason);
  return true;
}

// Combine an external signal (e.g. parent execution's abort) with a
// per-step timeout signal so the step honors whichever fires first.
//
// Uses the platform `AbortSignal.any` rather than hand-rolled
// addEventListener wiring: the manual version registered a listener on
// each LONG-LIVED parent signal (the execution-scoped controller) per
// step and never removed it, so listeners — and the per-step closures
// they captured — accumulated on the parent for the whole execution
// (MaxListenersExceededWarning + memory retention on long runs).
// `AbortSignal.any` manages its source subscriptions internally and
// releases them when the derived signal becomes unreachable.
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
