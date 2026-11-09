interface SkillSchemaGateResult {
  ok: boolean;
  missing_fields: string[];
}

export function validateOutputSchemaSuperset(
  skill: Record<string, unknown> | null | undefined,
  workflow: Record<string, unknown> | null | undefined,
): SkillSchemaGateResult {
  if (!skill || typeof skill !== "object") return { ok: true, missing_fields: [] };
  const skillRequired = collectRequiredTopLevel(skill);
  if (skillRequired.length === 0) return { ok: true, missing_fields: [] };
  const workflowProps = collectTopLevelProps(workflow);
  const missing = skillRequired.filter((f) => !workflowProps.has(f));
  return { ok: missing.length === 0, missing_fields: missing };
}

function collectRequiredTopLevel(schema: Record<string, unknown>): string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((f): f is string => typeof f === "string");
}

function collectTopLevelProps(schema: Record<string, unknown> | null | undefined): Set<string> {
  if (!schema || typeof schema !== "object") return new Set();
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return new Set();
  return new Set(Object.keys(props as Record<string, unknown>));
}
