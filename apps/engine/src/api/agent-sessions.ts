import { z } from "@hono/zod-openapi";

export const TRANSCRIPT_MAX_CHARS = 1_000_000;
const MAX_LEARNINGS_PER_SESSION = 8;
export const LEARNING_EVIDENCE_MAX_CHARS = 500;

export const LearningKindSchema = z
  .enum(["practice", "fact"])
  .describe(
    "practice = how to work (a rule, convention or gotcha); fact = what is true in the domain (a name, number, owner, policy). A hint for the review; the person decides whether it becomes knowledge, a skill, or nothing.",
  );
export type LearningKind = z.infer<typeof LearningKindSchema>;

const ExtractedLearningKindSchema = z
  .enum(["practice", "fact", "event", "secret"])
  .describe(
    "practice = how to work; fact = what is true in the domain; event = a status or something that happened (a release, a run, a removal); secret = names credentials, keys or where they are stored. Events and secrets are never collected.",
  );

export const LearningSchema = z.object({
  kind: ExtractedLearningKindSchema,
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4_000),
  pitfalls: z.array(z.string().min(1).max(500)).max(5).default([]),
  evidence: z
    .string()
    .min(1)
    .max(LEARNING_EVIDENCE_MAX_CHARS)
    .optional()
    .describe("A short quote of what the human said that supports this learning."),
  confidence: z.enum(["low", "medium", "high"]),
});

export const DistillationSchema = z.object({
  learnings: z.array(LearningSchema).max(MAX_LEARNINGS_PER_SESSION),
});
