import { z } from "@hono/zod-openapi";

export function normalizeWorkflowInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    return value;
  }
  return value;
}

export function workflowInputRecord(value: unknown): Record<string, unknown> {
  const normalized = normalizeWorkflowInput(value);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    return normalized as Record<string, unknown>;
  }
  return {};
}

export function structuredInputFields(properties: unknown, names: readonly string[]): string[] {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const props = properties as Record<string, unknown>;
  return names.filter((name) => {
    const prop = props[name];
    const type = prop && typeof prop === "object" ? (prop as { type?: unknown }).type : undefined;
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => t === "array" || t === "object");
  });
}

export const workflowInputSlot = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .transform((raw, ctx) => {
    const normalized = normalizeWorkflowInput(raw);
    if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
    if (typeof normalized === "string" && normalized.trim() === "") return {};
    ctx.addIssue({
      code: "custom",
      message:
        'input must be the workflow\'s input map (a JSON object), e.g. {"city":"Berlin"} — not a bare string',
    });
    return z.NEVER;
  })
  .pipe(z.record(z.string(), z.unknown()));
