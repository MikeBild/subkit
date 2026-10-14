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
    const claimedTool = /^tool\.([a-z][a-z0-9_]*)$/i.exec(args.missing_capability ?? "")?.[1];
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
    recordCannotHelp({
      ...(args.missing_capability ? { missing_capability: args.missing_capability } : {}),
    });
    await recordGapCandidate(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        requested: args.reason,
        missing_capability: args.missing_capability ?? null,
        ...(ctx.actor_id ? { actor_id: ctx.actor_id } : {}),
        actor: (() => {
          const context = ctx.engineClient.context;
          if (!context.actor_id) return null;
          if (context.actor_type !== "user" && context.actor_type !== "system_account") return null;
          return { id: context.actor_id, kind: context.actor_type };
        })(),
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
