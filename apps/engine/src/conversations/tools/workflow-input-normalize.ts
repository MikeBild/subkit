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

/** The workflow's input map is an object on the wire. Tolerate stringified
 * objects at ingress, then re-validate the normalized output so generated
 * schemas advertise an object, not an unconstrained or string union slot. */
export const workflowInputSlot = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .transform((raw, ctx) => {
    const normalized = normalizeWorkflowInput(raw);
    if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
    // Empty text means no supplied values; non-JSON prose is not an input map.
    if (typeof normalized === "string" && normalized.trim() === "") return {};
    ctx.addIssue({
      code: "custom",
      message:
        'input must be the workflow\'s input map (a JSON object), e.g. {"city":"Berlin"} — not a bare string',
    });
    return z.NEVER;
  })
  .pipe(z.record(z.string(), z.unknown()));
