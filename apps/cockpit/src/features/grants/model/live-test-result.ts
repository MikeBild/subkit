export function liveTestState(
  value: unknown,
): "blocked" | "pending" | "running" | "succeeded" | "failed" | null {
  if (!value || typeof value !== "object" || !("live_test" in value)) return null;
  const result = value.live_test;
  if (!result || typeof result !== "object" || !("state" in result)) return null;
  const state = result.state;
  if (state === "queued") return "pending";
  return state === "blocked" || state === "running" || state === "succeeded" || state === "failed"
    ? state
    : null;
}
