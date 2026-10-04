const TIMEOUT_SENTINEL = Symbol("inline_timeout");

export type InlineRunOutcome<T> = { timedOut: true } | { timedOut: false; result: T };

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
