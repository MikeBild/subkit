export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  backoff?: number;
  maxIntervalMs?: number;
  label?: string;
}

export async function pollUntil<T>(
  fn: () => T | Promise<T>,
  opts: PollOptions = {},
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxIntervalMs = opts.maxIntervalMs ?? 2_000;
  const backoff = opts.backoff ?? 1.5;
  let interval = opts.intervalMs ?? 250;
  const label = opts.label ?? "condition";

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const value = await fn();
      if (value !== undefined && value !== null && value !== false) {
        return value as NonNullable<T>;
      }
    } catch (err) {
      lastError = err;
    }
    // allow-wall-clock: bounded poll backoff — the only sleep pattern the
    // anti-flake guidance permits, gated by the deadline above.
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, maxIntervalMs)));
    interval = Math.min(interval * backoff, maxIntervalMs);
  }

  const suffix = lastError ? ` (last error: ${String(lastError)})` : "";
  throw new Error(
    `pollUntil timed out after ${timeoutMs}ms waiting for ${label} (${attempts} attempts)${suffix}`,
  );
}
