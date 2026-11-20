import { z } from "@hono/zod-openapi";

export const BoundActionSchema = z
  .object({
    verb: z.enum(["send", "create", "update", "run", "save", "other"]),
    effect_class: z.enum([
      "ordinary",
      "payment",
      "deletion",
      "publication",
      "permission_or_settings",
      "account_creation",
      "credential",
      "unknown",
    ]),
    target: z.string().nullable().describe("What the action acts on, e.g. `POST /v1/messages`."),
    account: z.string().nullable().describe("The connector or account the action goes through."),
    recipients: z.array(z.string()).describe("Addresses, links and handles the action reaches."),
    content_summary: z.string().nullable().describe("Shortened subject and text of the action."),
    content: z
      .string()
      .nullable()
      .optional()
      .describe("The full text the action would send or store, as drafted, for the card."),
  })
  .openapi("BoundAction");

export const RuleOfferSchema = z
  .object({
    rule_id: z.string().uuid(),
    tool: z.string(),
    verb: z.string(),
    target: z.string().nullable(),
    account: z.string().nullable(),
    recipients: z.array(z.string()),
  })
  .openapi("ToolApprovalRuleOffer");

export const ToolCallPolicySchema = z
  .object({
    ran_without_asking: z
      .boolean()
      .describe("True when the action ran without a confirmation card."),
    rule: z
      .enum(["user_instruction", "standing_rule"])
      .nullable()
      .describe("Why no card was shown: the person's own words or a rule they created."),
    bound_action: BoundActionSchema,
    because: z
      .object({
        quote: z.string().describe("The person's own words that ask for this action."),
        message_id: z.string().nullable().describe("The message the words were taken from."),
      })
      .nullable(),
    rule_id: z.string().uuid().nullable(),
    ask_reason: z
      .string()
      .nullable()
      .describe("Why the action asked instead of running, as a stable code."),
    ask_detail: z
      .string()
      .nullable()
      .optional()
      .describe("What exactly was missing, in plain words, when the action asked."),
    rule_offer: RuleOfferSchema.nullable().describe(
      "Offered once after the same kind of action was approved again: the person can store it as a rule.",
    ),
  })
  .openapi("ToolCallPolicy");

export type ToolCallPolicyView = z.infer<typeof ToolCallPolicySchema>;

export function toolCallPolicyView(confirmation_data: unknown): ToolCallPolicyView | null {
  if (!confirmation_data || typeof confirmation_data !== "object") return null;
  const data = confirmation_data as { policy?: unknown; rule_offer?: unknown };
  if (!data.policy || typeof data.policy !== "object") return null;
  const offer = RuleOfferSchema.safeParse(data.rule_offer);
  const parsed = ToolCallPolicySchema.safeParse({
    ...(data.policy as Record<string, unknown>),
    rule_offer: offer.success ? offer.data : null,
  });
  return parsed.success ? parsed.data : null;
}
