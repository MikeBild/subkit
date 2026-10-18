import { z } from "zod";
import { errorFields } from "../logging/logger.ts";

const queueErrorSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
  code: z.string().optional(),
  cause: z.unknown().optional(),
});

export function queueErrorFields(value: unknown): ReturnType<typeof errorFields> {
  if (value instanceof Error) return errorFields(value);
  const parsed = queueErrorSchema.safeParse(value);
  if (!parsed.success) {
    return errorFields(
      typeof value === "string" ? new Error(value) : new Error("Unknown queue error"),
    );
  }
  const { message, name, stack, code, cause } = parsed.data;
  const error = Object.assign(new Error(message, { cause }), { code });
  if (name !== undefined) error.name = name;
  if (stack !== undefined) error.stack = stack;
  else delete error.stack;
  return errorFields(error);
}
