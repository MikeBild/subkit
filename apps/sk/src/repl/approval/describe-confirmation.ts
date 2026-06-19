function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function truncateSummary(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 1))}…` : value;
}

export function describeApprovalTarget(target: unknown, maxChars = 80): string | null {
  if (typeof target === "string" && target.trim().length > 0) {
    return truncateSummary(target.trim(), maxChars);
  }
  const obj = readRecord(target);
  if (!obj) return null;
  const tool = readString(obj, ["tool"]);
  const args = readRecord(obj.args);
  if (tool) {
    const idHint = readString(args, [
      "target_workflow_id",
      "workflow_id",
      "slug",
      "connector_id",
      "id",
    ]);
    const environment = readString(args, ["environment"]);
    const summary = idHint
      ? `${tool} ${idHint}`
      : environment
        ? `${tool} env=${environment}`
        : tool;
    return truncateSummary(summary, maxChars);
  }
  const url = readString(obj, ["url", "path"]);
  if (!url) return null;
  const method = readString(obj, ["method"]);
  const summary = method ? `${method} ${url}` : url;
  return truncateSummary(summary, maxChars);
}

export function describeConfirmationPayload(input: unknown, maxChars = 80): string | null {
  const obj = readRecord(input);
  if (!obj) return null;
  const commitIntent = readRecord(obj.commit_intent);
  const description = readString(commitIntent, ["description"]);
  if (description) return truncateSummary(description, maxChars);
  const target = describeApprovalTarget(obj.target, maxChars);
  if (target) return target;
  const fallback = readString(obj, ["summary", "question"]);
  return fallback ? truncateSummary(fallback, maxChars) : null;
}
