export interface RemedyToolResult {
  tool: string;
  output: unknown;
}

const HANDOVER_TOOLS: ReadonlySet<string> = new Set(["review_workflow_automation"]);

const HELD_PREVIEW_TOOLS: ReadonlySet<string> = new Set(["dry_run_workflow", "dry_run_step"]);

const NON_ACTION_TOOLS: ReadonlySet<string> = new Set(["cannot_help"]);

const DECISION_TOOLS: ReadonlySet<string> = new Set([
  "ask_user_choice",
  "ask_user_text",
  "ask_user_form",
  "ask_user_multi",
]);

export function isQuestionTool(name: string): boolean {
  return name.startsWith("ask_user_");
}

export function isBusinessDecisionTool(name: string): boolean {
  return DECISION_TOOLS.has(name);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function refusalRemedies(output: unknown): string[] | null {
  const envelope = record(output);
  if (!envelope) return null;
  const data = record(envelope.data);
  const failed =
    envelope.ok === false ||
    typeof envelope.error_code === "string" ||
    typeof data?.error_code === "string";
  if (!failed) return null;
  const raw = Array.isArray(data?.next_best_actions)
    ? data.next_best_actions
    : Array.isArray(envelope.next_best_actions)
      ? envelope.next_best_actions
      : [];
  const remedies = raw.filter((name): name is string => typeof name === "string");
  return remedies.length > 0 ? remedies : null;
}

function awaitsConfirmation(output: unknown): boolean {
  const envelope = record(output);
  const code = envelope?.error_code ?? record(envelope?.data)?.error_code;
  return typeof code === "string" && code.endsWith("confirmation_required");
}

export function isSideEffectFreeRemedy(
  tool: string,
  readOnly: (name: string) => boolean = () => false,
): boolean {
  return HELD_PREVIEW_TOOLS.has(tool) || HANDOVER_TOOLS.has(tool) || readOnly(tool);
}

export function latestRefusalIndex(results: readonly RemedyToolResult[]): number {
  for (let index = results.length - 1; index >= 0; index--) {
    if (refusalRemedies(results[index]?.output)) return index;
  }
  return -1;
}

export function pendingPermittedRemedy(
  results: readonly RemedyToolResult[],
  availableTools: ReadonlySet<string>,
  options: { questionAnswers: boolean; readOnly?: (name: string) => boolean },
): string[] {
  const index = latestRefusalIndex(results);
  if (index < 0 || awaitsConfirmation(results[index]?.output)) return [];
  const remedies = refusalRemedies(results[index]?.output) ?? [];
  const later = results.slice(index + 1).map((result) => result.tool);
  if (later.some((tool) => remedies.includes(tool) || HANDOVER_TOOLS.has(tool))) return [];
  if (options.questionAnswers && later.some(isQuestionTool)) return [];
  return remedies.filter(
    (tool) =>
      availableTools.has(tool) &&
      !isQuestionTool(tool) &&
      !NON_ACTION_TOOLS.has(tool) &&
      isSideEffectFreeRemedy(tool, options.readOnly),
  );
}
