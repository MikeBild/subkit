import { z } from "@hono/zod-openapi";

const Text = z.string().trim().min(1).max(600);
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const PlaybookResourceSchema = z.object({
  type: z.enum(["connector", "workflow", "execution", "knowledge", "file", "intake"]),
  id: z.string().uuid(),
});
export const PlaybookCriterionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("assessment"),
    description: Text,
    result: z.string().trim().min(20).max(8000).nullable(),
  }),
  z.object({ kind: z.literal("resource_observed"), resource: PlaybookResourceSchema }),
  z.object({
    kind: z.literal("execution_succeeded"),
    workflow_id: z.string().uuid(),
    environment: z.enum(["dev", "prod"]),
    after: z.string().datetime({ offset: true }),
  }),
  z.object({ kind: z.literal("human_confirmation"), question: Text }),
]);
export const PlaybookNextActionSchema = z.object({
  label: Text,
  owner: Text.nullable(),
  elicitation_id: z.string().uuid().nullable(),
});
export const PlaybookStepInputSchema = z.object({
  id: Id,
  label: Text,
  criterion: PlaybookCriterionSchema,
  depends_on: z.array(Id).max(20),
  evidence_ids: z.array(z.string().uuid()).max(10),
  note: Text.nullable(),
  progress: z.enum(["open", "in_progress", "blocked", "waiting_for_input"]),
  next_action: PlaybookNextActionSchema.nullable(),
});
export const PlaybookPlanSchema = z
  .object({
    title: Text,
    goal: Text,
    steps: z.array(PlaybookStepInputSchema).min(1).max(20),
    cancelled: z.boolean(),
    completion_step_id: Id.nullable().describe(
      "Leave null for assessment results and resource reads. Set an ID only when that step's explicit proof is human_confirmation or execution_succeeded.",
    ),
  })
  .superRefine((plan, ctx) => {
    const completion = plan.steps.find((step) => step.id === plan.completion_step_id);
    if (
      plan.completion_step_id &&
      (!completion ||
        !["human_confirmation", "execution_succeeded"].includes(completion.criterion.kind))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completion_step_id"],
        message:
          "Completion requires an explicit human confirmation or a new successful execution.",
      });
    }
    if (
      completion?.criterion.kind === "human_confirmation" &&
      !completion.criterion.question.includes(plan.goal)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completion_step_id"],
        message: "The final confirmation question must explicitly include the complete goal.",
      });
    }
    const seen = new Set<string>();
    for (const [index, step] of plan.steps.entries()) {
      if (seen.has(step.id) || step.depends_on.some((id) => !seen.has(id))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index],
          message: "Step IDs must be unique; dependencies must refer to earlier steps.",
        });
      }
      seen.add(step.id);
    }
  });
export const PlaybookUpdateSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    plan: PlaybookPlanSchema,
  })
  .openapi("UpdateConversationPlaybook");
export const PlaybookDocumentSchema = z.object({
  id: z.string().uuid(),
  plan: PlaybookPlanSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  evidence_fingerprints: z.record(z.string(), z.string()),
  request_fingerprint: z.string().optional(),
});
export const PlaybookEvidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["tool_call", "execution", "decision"]),
  label: z.string(),
  resource_type: z.string().nullable(),
  resource_id: z.string().nullable(),
  observed_at: z.string().nullable(),
  freshness: z.enum(["fresh", "stale", "unavailable"]),
  href: z.string().nullable(),
});
export const PlaybookStepViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  criterion: z.string(),
  depends_on: z.array(z.string()),
  status: z.enum([
    "open",
    "in_progress",
    "waiting_for_input",
    "blocked",
    "verified",
    "assessment_ready",
    "stale",
    "not_applicable",
  ]),
  reason: z.string(),
  assurance: z.enum(["technical", "human", "assessment"]),
  evidence: z.array(PlaybookEvidenceSchema),
  next_action: PlaybookNextActionSchema.nullable(),
});
export const PlaybookViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    goal: z.string(),
    revision: z.number().int().nonnegative(),
    status: z.enum([
      "open",
      "in_progress",
      "waiting_for_input",
      "blocked",
      "prepared",
      "completed",
      "cancelled",
    ]),
    summary: z.string(),
    steps: z.array(PlaybookStepViewSchema),
    next_action: PlaybookNextActionSchema.nullable(),
    completion: z.object({
      status: z.enum(["open", "verified"]),
      label: z.string(),
      reason: z.string(),
    }),
    updated_at: z.string(),
  })
  .openapi("ConversationPlaybook");
export type PlaybookPlan = z.infer<typeof PlaybookPlanSchema>;
export type PlaybookDocument = z.infer<typeof PlaybookDocumentSchema>;
export type PlaybookView = z.infer<typeof PlaybookViewSchema>;
export type PlaybookStep = z.infer<typeof PlaybookStepInputSchema>;
export type PlaybookEvidence = z.infer<typeof PlaybookEvidenceSchema>;
export type PlaybookResource = z.infer<typeof PlaybookResourceSchema>;
