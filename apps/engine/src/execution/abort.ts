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
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort((s as AbortSignal & { reason?: unknown }).reason ?? "aborted");
      return ctrl.signal;
    }
    s.addEventListener(
      "abort",
      () => {
        ctrl.abort((s as AbortSignal & { reason?: unknown }).reason ?? "aborted");
      },
      { once: true },
    );
  }
  return ctrl.signal;
}
