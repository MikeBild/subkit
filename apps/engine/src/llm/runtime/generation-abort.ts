import { z } from "zod";

const GENERATION_NEED_KINDS = [
  "endpoint_contract",
  "response_shape",
  "connector_choice",
  "user_fact",
  "skill_guidance",
] as const;

const nullableText = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

export const GenerationNeedSchema = z.object({
  kind: z.enum(GENERATION_NEED_KINDS),
  connector_slug: nullableText,
  method: nullableText.transform((value) => (value ? value.toUpperCase() : null)),
  path: nullableText,
  question: nullableText,
  skill_slug: z.string().trim().min(1).max(120).nullish(),
});

export type GenerationNeed = z.infer<typeof GenerationNeedSchema>;

export interface GenerationAbort {
  reason: string;
  needs: GenerationNeed[];
}

const MAX_GENERATION_NEEDS = 8;

const NULLABLE_STRING = { type: ["string", "null"] } as const;

export const GENERATION_ABORT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description: "What is missing or impossible, in one or two sentences.",
    },
    needs: {
      type: "array",
      description:
        "Each concrete fact the caller must supply before the task can succeed. Empty when nothing specific can be named.",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...GENERATION_NEED_KINDS],
            description:
              "endpoint_contract: the exact route, parameters or body of an operation; response_shape: the recorded response fields of an operation; connector_choice: which of several connectors to use; user_fact: a business fact only the user knows; skill_guidance: the complete guidance of a skill the skill index marks load on demand.",
          },
          connector_slug: {
            ...NULLABLE_STRING,
            description: "Slug of the connector the need concerns, or null.",
          },
          method: { ...NULLABLE_STRING, description: "HTTP method of the operation, or null." },
          path: {
            ...NULLABLE_STRING,
            description: "Route of the operation exactly as documented, or null.",
          },
          question: {
            ...NULLABLE_STRING,
            description:
              "The question to put to the user for connector_choice or user_fact, or null.",
          },
          skill_slug: {
            ...NULLABLE_STRING,
            description: "Slug of the skill to load for skill_guidance, or null.",
          },
        },
        required: ["kind", "connector_slug", "method", "path", "question", "skill_slug"],
        additionalProperties: false,
      },
    },
  },
  required: ["reason", "needs"],
  additionalProperties: false,
} as const;

export const NO_REASON_GIVEN = "the model declined without giving a reason";

export function parseGenerationAbort(input: unknown): GenerationAbort {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const reason =
    typeof record.reason === "string" && record.reason.trim() !== ""
      ? record.reason.trim()
      : NO_REASON_GIVEN;
  const rawNeeds = Array.isArray(record.needs) ? record.needs : [];
  const needs: GenerationNeed[] = [];
  for (const raw of rawNeeds) {
    const parsed = GenerationNeedSchema.safeParse(raw);
    if (parsed.success) needs.push(parsed.data);
    if (needs.length >= MAX_GENERATION_NEEDS) break;
  }
  return { reason, needs };
}

export function isUserNeed(need: GenerationNeed): boolean {
  return need.kind === "connector_choice" || need.kind === "user_fact";
}
