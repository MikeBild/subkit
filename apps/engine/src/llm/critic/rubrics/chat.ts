import { z } from "zod";

const ChatVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  hint: z.string().optional(),
  checks: z
    .object({
      ids_grounded: z.boolean(),
      runtime_values_consistent: z.boolean(),
      no_placeholder_markers: z.boolean(),
      counts_consistent: z.boolean(),
    })
    .partial()
    .default({}),
});

export const chatRubric = {
  kind: "chat" as const,
  schema: ChatVerdictSchema,
  prompt: "",
};
