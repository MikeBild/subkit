import { z } from "@hono/zod-openapi";

export const ResumeFormFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "select", "json", "multi"]),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  options: z
    .union([z.array(z.string()), z.array(z.object({ value: z.string(), label: z.string() }))])
    .optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
});
export type ResumeFormField = z.infer<typeof ResumeFormFieldSchema>;
export function resumeFormFields(input: unknown): ResumeFormField[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) return undefined;
  // Secret entry belongs to the dedicated credential flow, never a chat form.
  if (input.some((field) => field?.sensitive === true || field?.type === "password"))
    return undefined;
  const parsed = z.array(ResumeFormFieldSchema).safeParse(input);
  if (
    !parsed.success ||
    new Set(parsed.data.map((field) => field.name)).size !== parsed.data.length
  )
    return undefined;
  return parsed.data;
}
