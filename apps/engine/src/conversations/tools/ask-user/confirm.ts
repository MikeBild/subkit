// ask_user_confirm — ask the user to approve or reject a specific
// action. Unifies the legacy `request_human_approval` surface. The
// `kind` field lets the client pick the right sub-renderer
// (save-workflow-draft diff, external-write target, generic fallback).
//
// Commit and external-write callers emit this tool.

import { z } from "@hono/zod-openapi";

import { scrubStringsDeep } from "../../../logging/scrub-secrets.ts";
import { requestApproval } from "../../../tools/approval.ts";
import {
  authoringIntentFingerprint,
  type ConfirmIntent,
  intentHasDistinguishingAction,
} from "../../intent-fingerprint.ts";
import type { ConversationTool, ToolResult } from "../index.ts";
import { resolveConversationPrincipal } from "../permission-gate.ts";
import type { ModelCommitIntent } from "./commit-intent.ts";
import { commitIntentSchema, describePatchOps, withApprovalHandle } from "./commit-intent.ts";
import { pauseForUserInput } from "./common.ts";

function toolForCommitIntent(intent: ModelCommitIntent): string {
  switch (intent.kind) {
    case "save_connector_draft":
    case "save_workflow_draft":
    case "delete_connector":
    case "delete_workflow":
    case "run_workflow":
    case "create_api_key":
      return intent.kind;
    case "apply_workflow_patch":
      return "edit_workflow_patch";
    case "update_workflow_metadata":
      return "update_workflow";
    case "oauth_completed":
      return "authenticate_oauth";
    case "credential_reissue_completed":
      return "request_connector_reauth";
    case "rollback_after_execute":
      return "rollback_after_execute";
  }
}

async function approvalBackedMcpIntent(
  ctx: Parameters<ConversationTool["execute"]>[0],
  intent: ModelCommitIntent | undefined,
): Promise<
  | { ok: true; intent: ModelCommitIntent | undefined; approval_url?: string }
  | { ok: false; error_code: string; message: string }
> {
  if (!intent || ctx.surface !== "mcp") return { ok: true, intent };
  const principal = ctx.principal ?? (await resolveConversationPrincipal(ctx));
  if (!principal) {
    return {
      ok: false,
      error_code: "principal_required",
      message:
        "MCP write confirmation requires an authenticated principal. No approval was opened and nothing was written.",
    };
  }
  const approvalId = crypto.randomUUID();
  const tool = toolForCommitIntent(intent);
  try {
    const requested = await requestApproval({
      db: ctx.db,
      principal,
      approval_id: approvalId,
      tool,
      surface: "chat",
      via: "chat",
      reason: "permission_mode",
      execution_mode: null,
      args: { commit_intent: intent },
    });
    return {
      ok: true,
      intent: withApprovalHandle(intent, approvalId) as unknown as ModelCommitIntent,
      ...(requested.approval_url ? { approval_url: requested.approval_url } : {}),
    };
  } catch {
    return {
      ok: false,
      error_code: "approval_request_failed",
      message:
        "The approval could not be persisted. No confirmation was opened and nothing was written.",
    };
  }
}

function buildOverrideWarning(intent: ModelCommitIntent | undefined): string | null {
  if (!intent) return null;
  const payload = intent.payload;
  if (intent.kind === "save_workflow_draft" && payload.force_commit === true) {
    return "⚠ Override: this will commit the workflow despite a failed preview.";
  }
  if (intent.kind === "save_connector_draft" && payload.force_save === true) {
    return "⚠ Override: this will save the connector despite a failed probe.";
  }
  return null;
}

function defaultCommitIntent(args: z.infer<typeof inputSchema>): ModelCommitIntent | undefined {
  if (args.commit_intent) return args.commit_intent;
  if (args.kind !== "save_workflow_draft") return undefined;
  return {
    kind: "save_workflow_draft",
    payload: {},
    description: args.summary ?? args.question,
  };
}

const inputSchema = z
  .object({
    question: z.string().min(1),
    kind: z
      .enum(["save_workflow_draft", "external_write", "generic", "partial_diff_approval"])
      .default("generic"),
    summary: z.string().optional(),
    /** Structured before/after JSON for save_workflow_draft kinds. */
    diff: z.unknown().optional(),
    /**
     * Per-op review rows for `partial_diff_approval` kinds. Optional —
     * when omitted the engine derives them from the `apply_workflow_patch`
     * commit_intent's `payload.patches`, so the model never has to duplicate
     * the diff list. Each row is `{ label, preview? }`; the client renders a
     * per-row accept/reject toggle and the operator's selection rides back on
     * `output.approved_indices`.
     */
    diffs: z.array(z.object({ label: z.string(), preview: z.string().optional() })).optional(),
    /** Free-form target descriptor for external_write kinds. */
    target: z.unknown().optional(),
    /**
     * Hint to the client that the action is dangerous; rendered
     * red-bold and defaults selection to Reject.
     */
    destructive: z.boolean().optional(),
    /** Default choice if the user just presses Enter. */
    default: z.enum(["approve", "reject"]).optional(),
    /**
     * Optional commit intent. When set and the operator approves, the
     * harness applies the intended write atomically — the LLM does
     * NOT need to call save_connector_draft / save_workflow_draft / delete_*
     * afterwards. See `./commit-intent.ts` for the schema.
     */
    commit_intent: commitIntentSchema.optional(),
  })
  .openapi("AskUserConfirmInput");

export const askUserConfirmTool: ConversationTool = {
  name: "ask_user_confirm",
  description:
    'Ask the user to approve or reject a specific action. The client renders a styled confirm prompt with an optional feedback reason; the resolved boolean resumes the loop. If you pass `commit_intent`, the harness applies the intended write atomically when the operator approves — you DO NOT need to call the underlying tool afterwards (the next turn will already see a synthetic tool result with source="harness_auto_persist").',
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const proposedCommitIntent = defaultCommitIntent(args);
    // Declined-intent guard: if the operator already declined this exact
    // action in THIS conversation, answer with the prior decline instead of
    // re-prompting — even in `auto` mode, because an explicit "no" on an
    // identical action outranks session-level implicit approval. Keyed by the
    // intent fingerprint (kind + commit_intent + target + draft identity), so
    // an edited draft yields a new fingerprint and prompts normally. Only
    // proposals carrying a concrete action (commit_intent / target) are
    // guarded — a bare question has no stable identity to remember. Fail-open:
    // a null fingerprint falls through to the prompt.
    // Fingerprint the SCRUBBED projection: the recorder hashes the persisted
    // elicitation input, which `pauseForUserInput` scrubs for secrets before
    // it is stored. Scrubbing here too keeps the guard's live fingerprint
    // byte-identical to the recorded one — otherwise a confirm carrying a
    // secret-shaped string would hash differently on the two sides and the
    // guard would silently never match.
    const confirmIntent = scrubStringsDeep({
      kind: args.kind,
      commit_intent: proposedCommitIntent,
      target: args.target,
    }) as ConfirmIntent;
    const denied = ctx.getDraft().state?.last_denied_intent;
    if (denied?.fingerprint && intentHasDistinguishingAction(confirmIntent)) {
      const candidateFp = authoringIntentFingerprint(confirmIntent, ctx.getDraft());
      if (candidateFp && candidateFp === denied.fingerprint) {
        // One-shot escape — but ONLY in an attended mode, where a human is
        // present to deliberately retry: clear the stamp so the NEXT identical
        // proposal reaches a prompt. In `auto` mode there is no human
        // re-driving, so the earlier explicit "no" must stay sticky and is
        // never cleared — otherwise a second identical re-proposal would fall
        // through to the auto-resolve branch and silently auto-approve the very
        // action the operator declined. Clearing is best-effort (fail-open):
        // a failed write just leaves the stamp in place, the safe direction.
        if (ctx.permission_mode !== "auto") {
          const draft = ctx.getDraft();
          if (draft.state) {
            draft.state.last_denied_intent = null;
            try {
              await ctx.setDraft(draft);
            } catch {
              // Keep the stamp — a persist failure must not surface as a
              // tool crash, and a still-set stamp only re-suppresses once more.
            }
          }
        }
        return {
          ok: true,
          data: {
            confirmed: false,
            already_declined: true,
            reason:
              "The operator already declined this exact action earlier in this conversation. Not re-prompting. Propose a different approach or move on.",
          },
        };
      }
    }
    // Auto-resolve when the client is in `permission_mode=auto`. The
    // mode itself IS the governance signal — save_workflow_draft, external
    // writes, run_workflow, save_connector_draft were all visible in
    // the chat as concrete next-step proposals before the model
    // emitted ask_user_confirm, so the user has already authored
    // implicit approval at session level (the bottom-bar `auto` chip).
    // The single carve-out: `destructive=true` keeps the explicit
    // gate because that's the model's own signal that the action is
    // dangerous (delete_*, revoke_*, irreversible writes). That carve-
    // out plus DANGEROUS_TOOLS in tool-policies.ts is the safety net.
    // "ask" and "plan" modes fall through to the normal pause path.
    //
    // Note: when the CALLER explicitly set `commit_intent`, we still
    // pause even in `auto` mode — the harness needs the explicit submit
    // signal so the auto-persist dispatcher fires deterministically.
    // The auto-mode shortcut stays valid for bare save_workflow_draft confirms
    // that the model owns end-to-end.
    if (
      ctx.permission_mode === "auto" &&
      args.destructive !== true &&
      args.commit_intent === undefined
    ) {
      return {
        ok: true,
        data: {
          confirmed: true,
          auto_resolved: true,
          reason: `permission_mode=auto skipped ${args.kind} confirmation`,
        },
      };
    }
    // When the commit_intent declares an override (force_commit /
    // force_save), prepend an explicit warning line so the operator
    // knows their single confirmation will commit despite a failed
    // gate. Without this, the LLM ended up narrating a confused
    // two-step retry ("blocked … now using force_commit") that
    // required a second "approve" from the user.
    const overrideWarning = buildOverrideWarning(proposedCommitIntent);
    const baseSummary = args.summary ?? args.question;
    const summary = overrideWarning ? `${overrideWarning}\n\n${baseSummary}` : baseSummary;
    // Per-op review rows for the partial-accept card. Derive them
    // from the `apply_workflow_patch` commit_intent's patches when the model
    // did not supply an explicit `diffs` list, so the client's
    // PartialApprovalPrompt can render one accept/reject toggle per op.
    const partialDiffs =
      args.kind === "partial_diff_approval"
        ? (args.diffs ??
          (proposedCommitIntent?.kind === "apply_workflow_patch" &&
          Array.isArray(proposedCommitIntent.payload.patches)
            ? describePatchOps(proposedCommitIntent.payload.patches)
            : undefined))
        : undefined;
    const approvalBacked = await approvalBackedMcpIntent(ctx, proposedCommitIntent);
    if (!approvalBacked.ok) {
      return {
        ok: false,
        error_code: approvalBacked.error_code,
        message: approvalBacked.message,
        data: {
          error_code: approvalBacked.error_code,
          reason: approvalBacked.error_code,
        },
      };
    }
    const effectiveCommitIntent = approvalBacked.intent;
    const input: Record<string, unknown> = { ...args };
    if (effectiveCommitIntent !== undefined) input.commit_intent = effectiveCommitIntent;
    if (approvalBacked.approval_url !== undefined) {
      input.approval_url = approvalBacked.approval_url;
    }
    if (partialDiffs !== undefined) input.diffs = partialDiffs;
    return pauseForUserInput(ctx, {
      tool_name: "ask_user_confirm",
      summary,
      input,
    });
  },
};
