import { z } from "@hono/zod-openapi";

export const BECAUSE_ARG = "__because";

export const BECAUSE_DESCRIPTION =
  "Only when the person explicitly asked for exactly this action in their latest message: quote their own words that ask for it, verbatim. The engine checks the quote against what the person wrote and against the target, recipient, amount and date they named; when all of it matches, the action runs once without a confirmation. Omit it in every other case. A quote that is not in the person's words makes the action ask. In a task run, the task's goal counts as the person's words: quote it verbatim.";

export function takeBecause(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  because: string | null;
} {
  if (!Object.hasOwn(args, BECAUSE_ARG)) return { args, because: null };
  const { [BECAUSE_ARG]: raw, ...rest } = args;
  return { args: rest, because: typeof raw === "string" && raw.trim().length > 0 ? raw : null };
}

export function withBecauseField<T>(schema: T): T {
  if (!(schema instanceof z.ZodObject)) return schema;
  try {
    return schema.extend({
      [BECAUSE_ARG]: z.string().max(400).optional().describe(BECAUSE_DESCRIPTION),
    }) as unknown as T;
  } catch {
    return schema;
  }
}

export function withBecauseJsonProperty(schema: Record<string, unknown>): Record<string, unknown> {
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  return {
    ...schema,
    properties: {
      ...properties,
      [BECAUSE_ARG]: { type: "string", maxLength: 400, description: BECAUSE_DESCRIPTION },
    },
  };
}
