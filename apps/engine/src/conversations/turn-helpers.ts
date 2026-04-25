// Pure helpers the conversation loop uses for stream-level stop
// conditions and post-turn fallbacks. Kept in their own module so they
// can be unit-tested without spinning the DB / provider stack.

import type { TurnEvent } from "./types.ts";

/**
 * Stop the stream when the per-turn loop-warning budget is exhausted —
 * the per-tool loop-breaker in sdk-wrap sets `reason: "turn_loop_budget_exhausted"`
 * on its wrapped result once `signals.totalLoopWarnings` crosses the
 * turn-level cap. Without this, the model keeps getting re-driven into
 * the same short-circuit and burns the entire step budget with nothing
 * to show for it (observed in session 4e6696e3: 20 rounds, 1.1 M tokens,
 * empty output).
 */
export const turnLoopBudgetStopCondition = ({
  steps,
}: {
  steps: ReadonlyArray<{
    toolResults: ReadonlyArray<{ output?: unknown }>;
  }>;
}): boolean => {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return last.toolResults.some((result) => {
    const output = result.output;
    if (!output || typeof output !== "object") return false;
    const data = (output as { data?: unknown }).data;
    if (!data || typeof data !== "object") return false;
    return (data as { reason?: unknown }).reason === "turn_loop_budget_exhausted";
  });
};

/**
 * Build a short fallback message from collected `tool_result` events
 * when the turn finished without the model producing any text. Walks
 * the events, picks the last output per tool name, and renders a
 * one-line summary per tool.
 *
 * Output is English. The model is responsible for any locale-aware
 * surface text in the regular path; the fallback is a backstop and
 * stays in one canonical language so observability + test-snapshot
 * matchers don't drift across tenants.
 *
 * Returns null when there is no meaningful signal — callers then
 * decide between a generic apology line and silence. An empty
 * assistant text is always worse than a synthesised paragraph, so the
 * loop should prefer this over rendering `""`.
 */
export function synthesizeFallbackMessage(params: {
  events: ReadonlyArray<TurnEvent>;
  loopWarnings: number;
}): string | null {
  const latestPerTool = new Map<string, Record<string, unknown>>();
  for (const ev of params.events) {
    if (ev.type !== "tool_result") continue;
    const output = ev.output;
    if (!output || typeof output !== "object") continue;
    latestPerTool.set(ev.tool, output as Record<string, unknown>);
  }
  if (latestPerTool.size === 0) {
    return params.loopWarnings > 0
      ? "I kept hitting the same call and stopped the turn before burning more tokens. Try rephrasing or tell me what to do next."
      : null;
  }
  const lines: string[] = [];
  for (const [tool, output] of latestPerTool) {
    lines.push(`- ${tool}: ${describeToolOutput(output)}`);
  }
  const header =
    params.loopWarnings > 0
      ? "I stopped this turn early because the model kept repeating the same call. Here is what I already gathered:"
      : "Summary of the latest tool results:";
  return `${header}\n${lines.join("\n")}`;
}

function describeToolOutput(output: Record<string, unknown>): string {
  const candidateKeys = [
    "workflows",
    "connectors",
    "skills",
    "executions",
    "items",
    "hits",
    "results",
  ];
  for (const key of candidateKeys) {
    const value = output[key];
    if (Array.isArray(value)) return `${value.length} entries`;
  }
  if (output._truncated && typeof output._note === "string") return String(output._note);
  if (typeof output.error === "string") return `error: ${output.error.slice(0, 160)}`;
  if (typeof output.reason === "string") return `note: ${String(output.reason)}`;
  const keys = Object.keys(output).filter((k) => !k.startsWith("_"));
  return keys.length > 0 ? `fields: ${keys.slice(0, 5).join(", ")}` : "no structured output";
}
