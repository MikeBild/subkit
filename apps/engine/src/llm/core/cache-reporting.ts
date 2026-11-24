export function cacheReadReported(
  usage:
    | {
        raw?: unknown;
        inputTokenDetails?: { cacheReadTokens?: unknown } | undefined;
      }
    | undefined,
): boolean {
  const raw = usage?.raw;
  if (raw && typeof raw === "object") {
    const u = raw as Record<string, unknown>;
    if ("prompt_tokens" in u || "input_tokens" in u) {
      const details = (u.prompt_tokens_details ?? u.input_tokens_details) as
        | { cached_tokens?: unknown }
        | undefined;
      return details?.cached_tokens != null || u.cache_read_input_tokens != null;
    }
  }
  return usage?.inputTokenDetails?.cacheReadTokens != null;
}
