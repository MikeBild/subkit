export type ProviderFault = "rate_limit" | "server_error" | "timeout" | "network";

const HTTP_STATUS = /→\s*(\d{3})\b/;

const CODE_FAULTS: ReadonlyArray<readonly [RegExp, ProviderFault]> = [
  [/\bllm_provider_limited\b/, "rate_limit"],
  [/\bllm_provider_unavailable\b/, "server_error"],
  [/\bllm_timeout\b/, "timeout"],
];

const TEXT_FAULTS: ReadonlyArray<readonly [RegExp, ProviderFault]> = [
  [/\brate[ _-]?limit/i, "rate_limit"],
  [/\boverloaded\b/i, "server_error"],
  [/\bTimeoutError\b|timed out|\bETIMEDOUT\b/i, "timeout"],
  [/\bAbortError\b|aborted due to timeout/i, "timeout"],
  [
    /fetch failed|\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|socket hang up|network error/i,
    "network",
  ],
];

export function classifyRunFault(error: string | undefined): ProviderFault | null {
  if (!error) return null;
  for (const [pattern, fault] of CODE_FAULTS) if (pattern.test(error)) return fault;
  const status = Number(HTTP_STATUS.exec(error)?.[1]);
  if (status === 429) return "rate_limit";
  if (status >= 500 && status <= 599) return "server_error";
  for (const [pattern, fault] of TEXT_FAULTS) if (pattern.test(error)) return fault;
  return null;
}

export const MAX_ATTEMPTS = 2;

export type AttemptOutcome<T> =
  | { kind: "scored"; value: T; attempts: number }
  | { kind: "faulted"; fault: ProviderFault; error: string; attempts: number };

export async function withFaultRetry<T>(
  attempt: () => Promise<{ value: T; error: string | undefined }>,
  onFault: (value: T, fault: ProviderFault, error: string, attempt: number) => Promise<void>,
): Promise<AttemptOutcome<T>> {
  let last: { fault: ProviderFault; error: string } | null = null;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const { value, error } = await attempt();
    const fault = classifyRunFault(error);
    if (fault === null) return { kind: "scored", value, attempts: n };
    last = { fault, error: error ?? "" };
    await onFault(value, fault, last.error, n);
  }
  return {
    kind: "faulted",
    fault: last?.fault ?? "network",
    error: last?.error ?? "",
    attempts: MAX_ATTEMPTS,
  };
}

export type CanaryVerdict = { ok: true } | { ok: false; reason: string; provider_down: boolean };

export function canaryVerdict(outcome: AttemptOutcome<{ error?: string }>): CanaryVerdict {
  if (outcome.kind === "faulted") {
    return {
      ok: false,
      provider_down: true,
      reason: `provider unavailable after ${outcome.attempts} attempts (${outcome.fault}): ${outcome.error}`,
    };
  }
  if (outcome.value.error) {
    return { ok: false, provider_down: false, reason: `canary failed: ${outcome.value.error}` };
  }
  return { ok: true };
}
