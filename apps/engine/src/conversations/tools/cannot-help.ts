// cannot_help — structured abstention.
//
// The assistant calls this when the user's request requires a tool it
// does not have, a manifest entry that is empty, or a piece of context
// it cannot ground from real tenant state. Calling cannot_help ends
// the turn (the loop stops via hasToolCall("cannot_help")) and the
// recorded { reason, missing_capability, suggest_alternative } feeds
// the capability-gap backlog the operator reads in observability.
//
// Without this tool, the LLM has only one escape valve when a
// capability is missing: invent something. cannot_help is the structured
// alternative — the assistant says "I can't do this, here is why" in a
// machine-readable shape instead of producing freeform text that
// pretends otherwise.

import { z } from "@hono/zod-openapi";
import { recordGapCandidate } from "../../discovery/service.ts";
import { recordCannotHelp } from "../../observability/instrumentation.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    reason: z
      .string()
      .min(1)
      .describe(
        "One sentence in plain English explaining what you cannot do and why. Shown to the user verbatim.",
      ),
    missing_capability: z
      .string()
      .optional()
      .describe(
        "Short slug for the capability the assistant would have needed (e.g. 'tool.create_oauth_app', 'vendor_recipe.cursor', 'manifest.tenant.empty'). Aggregated for the operator backlog.",
      ),
    suggest_alternative: z
      .string()
      .optional()
      .describe(
        "Optional: a concrete next step that stays actionable in the conversation (a different tool, a clarifying question, or grounded configuration guidance). Plain prose, one sentence.",
      ),
  })
  .openapi("CannotHelpInput");

export const cannotHelpTool: ConversationTool = {
  name: "cannot_help",
  description:
    "Structured abstention. Call this when the user's request requires a tool, manifest entry, or piece of grounded context that you do not have. Ends the turn cleanly; the user sees `reason` and any `suggest_alternative`. Prefer this over inventing — every cannot_help call grows the capability-gap backlog.",
  inputSchema,
  category: "tenant_read",
  use_case:
    "Use whenever you would otherwise have to invent a URL, CLI flag, tool, ID, vendor config, or any other reference that you cannot ground in real tenant state or a verified manifest.",
  important_notes: [
    "Calling this tool ends the turn — the user sees your `reason` and (if given) `suggest_alternative`. Do not also emit text claiming you have done the thing.",
    "`missing_capability` is read by operators as a backlog of capability gaps. Use a stable slug shape: `tool.<name>`, `vendor_recipe.<client>`, `manifest.<name>.empty`, `surface.<name>.unsupported`.",
    "Do NOT call this for errors that have a typed error code (those go through error-recovery). cannot_help is for structural absences: a tool that does not exist, a verified recipe we have not authored, a piece of context the user must supply.",
    "Keep `suggest_alternative` inside chat. Do not route the user to `sk` commands or raw HTTP calls for actions that belong on the conversation surface.",
  ],
  example_input: {
    reason:
      "I do not have a verified Codex MCP config in this engine yet — Codex's config shape changes between releases and I will not paste an unverified template.",
    missing_capability: "vendor_recipe.codex",
    suggest_alternative:
      "Check the official Codex MCP docs for the current config shape, or ask an admin to add a verified recipe.",
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    // A `tool.<name>` slug is a CHECKABLE claim, and this tool used to
    // take it on faith. Production: after `author_workflow` failed on a
    // timeout, the model abstained with
    // `missing_capability: "tool.author_workflow"`, reason "not available
    // in this MCP surface" — minutes after calling that same tool
    // successfully in the same turn. Two costs: the user was told
    // something false, and `recordGapCandidate` filed a durable,
    // demand-ranked capability gap for a capability that exists. That
    // backlog is read as evidence of what the product is missing; a
    // fabricated entry there is worse than noise, it misdirects.
    //
    // Only the structured slug is checked. The free-text `reason` is
    // deliberately left alone — `loop/tool-not-available-guard.ts` scans
    // prose and is observability ONLY, and wiring a regex verdict into
    // control flow is forbidden by contract. Validating a documented
    // field against the palette is not that; it is the same input
    // validation every other tool performs.
    const claimedTool = /^tool\.([a-z][a-z0-9_]*)$/i.exec(args.missing_capability ?? "")?.[1];
    // No palette threaded → cannot verify → let the abstention through.
    // An unverifiable claim must never be treated as a false one.
    if (claimedTool && ctx.availableToolNames?.has(claimedTool.toLowerCase())) {
      return {
        ok: false,
        data: {
          error_code: "capability_claim_false",
          message: `\`${claimedTool}\` IS available to you in this conversation — do not abstain claiming otherwise. Call it, or if it failed, say what it returned.`,
          recommended_mode: "workflow",
          next_best_actions: [claimedTool],
        },
      };
    }
    // Capability-gap analytics — the operator sees what the assistant
    // could not do, sorted by missing_capability slug, in the
    // `cannot_help_invocations_total` time series.
    recordCannotHelp({
      ...(args.missing_capability ? { missing_capability: args.missing_capability } : {}),
    });
    // Durable capability-gap signal — turns the abstention into a deduped,
    // demand-ranked backlog the operator can act on, instead of only a
    // counter tick that discards the request text. Best-effort: the helper
    // catches its own errors and returns null, so a bookkeeping failure
    // never breaks the abstention turn.
    await recordGapCandidate(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        requested: args.reason,
        missing_capability: args.missing_capability ?? null,
        ...(ctx.actor_id ? { actor_id: ctx.actor_id } : {}),
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        abstained: true,
        reason: args.reason,
        ...(args.missing_capability !== undefined
          ? { missing_capability: args.missing_capability }
          : {}),
        ...(args.suggest_alternative !== undefined
          ? { suggest_alternative: args.suggest_alternative }
          : {}),
      },
    };
  },
};
