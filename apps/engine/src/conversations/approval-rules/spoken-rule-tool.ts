import { z } from "@hono/zod-openapi";
import { ownWords } from "@shared/own-words.ts";
import { checkQuote } from "@shared/quote-text.ts";
import { describeBoundAction } from "../instruction-cover/bound-action.ts";
import { collectContent } from "../instruction-cover/content.ts";
import { connectorTemplateSlug } from "../instruction-cover/evidence.ts";
import { describeForCard, isCoverCandidate } from "../instruction-cover/gate.ts";
import type { ConversationTool, ToolResult } from "../tools/index.ts";
import { ruleFromWords } from "./core/spoken-rule.ts";
import { contentHash } from "./scope.ts";
import { offerSpokenRule } from "./store.ts";

const inputSchema = z
  .object({
    quote: z
      .string()
      .min(1)
      .max(400)
      .describe("The person's own words from their latest message that state the rule, verbatim."),
    tool: z.string().min(1).max(200).describe("The tool the rule is for, e.g. call_connector."),
    args: z
      .record(z.string(), z.unknown())
      .describe("The arguments of one action the rule should cover, as that tool takes them."),
  })
  .openapi("ProposeApprovalRuleToolInput");

function refused(error_code: string, message: string): ToolResult {
  return { ok: false, error_code, message, data: { rule_id: null, state: null } };
}

export const proposeApprovalRuleTool: ConversationTool = {
  name: "propose_approval_rule",
  description:
    "Offer the person a rule they just stated in their own words, such as 'from now on send the " +
    "weekly report to jane@example.com without asking'. The rule is only offered: it does not " +
    "apply until the person accepts it themselves in the cockpit. Pass their words verbatim as " +
    "the quote, and one action the rule should cover as tool and args. Never call this for a " +
    "single request, and never to widen what the person said.",
  inputSchema,
  category: "tenant_write" as const,
  inert_proposal: true,
  chat_only: true,
  use_case:
    "The person says an action may always run without a confirmation ('always', 'from now on', 'without asking') and names what and to whom.",
  important_notes: [
    "Creates an offered rule only; the person accepts or dismisses it. Nothing runs without a confirmation because of this call.",
    "The quote must be the person's own words from their latest message, and must name the action and every recipient.",
    "Actions that delete, pay, publish, or change access never get a rule.",
  ],
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const principal = ctx.principal;
    if (principal?.kind !== "user" || ctx.task_run)
      return refused(
        "person_required",
        "A rule can only be offered while the person it belongs to is in the conversation.",
      );
    if (!isCoverCandidate(args.tool))
      return refused("tool_not_coverable", `${args.tool} cannot run on a rule; it always asks.`);
    const quote = args.quote.trim();
    const checked = checkQuote(quote, ownWords(ctx.recentUserMessage ?? ""));
    if (!checked.ok)
      return refused(
        checked.reason,
        "The quote is not in the person's latest message in their own words. Quote them verbatim, or ask them to state the rule.",
      );
    const card = describeForCard(args.tool, args.args);
    const action = describeBoundAction(args.tool, args.args, card.recipients, {
      template: await connectorTemplateSlug(ctx.db, ctx.tenant_id, args.args),
    });
    if (!ruleFromWords(quote, action))
      return refused(
        "not_a_standing_rule",
        "These words do not state a standing rule for this action: they must say it may always run, name the action, and name every recipient.",
      );
    const offered = await offerSpokenRule(
      ctx.db,
      { tenant_id: ctx.tenant_id, user_id: principal.id },
      action,
      quote,
      contentHash(collectContent(args.tool, args.args)),
    );
    if (!offered) return refused("not_a_standing_rule", "This action cannot be covered by a rule.");
    return {
      ok: true,
      data: {
        rule_id: offered.rule_id,
        state: offered.state,
        note:
          offered.state === "active"
            ? "The person already has this rule; it stays as it is."
            : "Offered. It applies only after the person accepts it in the cockpit under approval rules.",
      },
    };
  },
};
