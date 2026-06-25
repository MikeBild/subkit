// Bound how long an inline async operation (a `wf_<slug>` run) is allowed to
// block a tools/call response. ChatGPT aborts tool calls at ~60s, so a slow
// run must stop blocking and hand back a polling handle while it finishes in
// the background. Extracted as a pure, dependency-free helper so the timing
// decision is unit-testable without a real (slow) workflow execution.

const TIMEOUT_SENTINEL = Symbol("inline_timeout");

export type InlineRunOutcome<T> = { timedOut: true } | { timedOut: false; result: T };

/**
 * Resolve to the run's result if it settles within `timeoutMs`, else report a
 * timeout. NEVER cancels `run` — the caller decides what to do with the still-
 * pending promise (keep it alive in the background, attach cleanup, etc.). The
 * internal timer is cleared on the fast path and `unref`'d so it can't keep the
 * process alive.
 */
export async function raceInlineRun<T>(
  run: Promise<T>,
  timeoutMs: number,
): Promise<InlineRunOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    timer.unref?.();
  });
  const raced = await Promise.race([run, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (raced === TIMEOUT_SENTINEL) return { timedOut: true };
  return { timedOut: false, result: raced };
}
