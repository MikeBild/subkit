export function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      ctrl.abort((signal as AbortSignal & { reason?: unknown }).reason ?? "aborted");
      return ctrl.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        ctrl.abort((signal as AbortSignal & { reason?: unknown }).reason ?? "aborted");
      },
      { once: true },
    );
  }
  return ctrl.signal;
}
