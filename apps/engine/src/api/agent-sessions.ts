import { z } from "@hono/zod-openapi";

export const TRANSCRIPT_MAX_CHARS = 1_000_000;
export const MAX_LEARNINGS_PER_SESSION = 8;

export const LearningKindSchema = z
  .enum(["practice", "fact"])
  .describe(
    "practice = how to work (a rule, convention or gotcha) and becomes a skill; fact = what is true in the domain (a name, number, owner, policy) and becomes part of the domain's knowledge source.",
  );
export type LearningKind = z.infer<typeof LearningKindSchema>;

export const LearningSchema = z.object({
  kind: LearningKindSchema,
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4_000),
  pitfalls: z.array(z.string().min(1).max(500)).max(5).default([]),
  confidence: z.enum(["low", "medium", "high"]),
});

export const DistillationSchema = z.object({
  learnings: z.array(LearningSchema).max(MAX_LEARNINGS_PER_SESSION),
});
