function looksLikeStructuredJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === "{" && last === "}") || (first === "[" && last === "]");
}

export function normalizeWorkflowRunInput(
  input: unknown,
  schema?: Record<string, unknown>,
): unknown {
  if (input === undefined && schema?.type === "object") return {};
  if (typeof input !== "string" || !looksLikeStructuredJson(input)) {
    return input;
  }
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export function workflowInputObjectKeys(input: unknown): string[] {
  const normalized = normalizeWorkflowRunInput(input);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return [];
  }
  return Object.keys(normalized);
}
