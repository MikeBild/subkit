// Sole consumer is `apps/engine/src/conversations/loop.ts` —
// merging multiple abort signals into one for the streamText
// call. The file lives under `_internal/` (not at the package root)
// so the conversations barrel at `../index.ts` cannot accidentally
// re-export it; cross-package consumers must reach across an
// explicit "internal" path or import directly. This is file-system
// enforcement of the layering instead of a comment
// that an "organize imports" tool could quietly drop.

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
