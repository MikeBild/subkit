import { z } from "@hono/zod-openapi";
import { scrubStringsDeep } from "../../../logging/scrub-secrets.ts";
import { requestApproval } from "../../../tools/approval.ts";
import { getWorkflowDraft } from "../../authoring-state.ts";
import {
  authoringIntentFingerprint,
  type ConfirmIntent,
  intentHasDistinguishingAction,
} from "../../intent-fingerprint.ts";
import {
  checkWorkflowSaveReadiness,
  commitWorkflowAtomic,
} from "../../persistence/commit-workflow.ts";
import { autoPreparationProceeds, getToolPolicies } from "../../tool-policies.ts";
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

type ToolCtx = Parameters<ConversationTool["execute"]>[0];

export interface AutoSaveDeps {
  loadPolicies: typeof getToolPolicies;
  checkReadiness: typeof checkWorkflowSaveReadiness;
  commit: typeof commitWorkflowAtomic;
}

const AUTO_SAVE_DEPS: AutoSaveDeps = {
  loadPolicies: getToolPolicies,
  checkReadiness: checkWorkflowSaveReadiness,
  commit: commitWorkflowAtomic,
};

export async function autoModeSaveWithoutPause(
  ctx: ToolCtx,
  intent: ModelCommitIntent | undefined,
  destructive: boolean,
  deps: AutoSaveDeps = AUTO_SAVE_DEPS,
): Promise<ToolResult | null> {
  if (ctx.permission_mode !== "auto" || destructive || ctx.surface === "mcp") return null;
  if (intent?.kind !== "save_workflow_draft") return null;
  const payload = intent.payload;
  if (payload.force_commit === true || payload.target_workflow_id !== undefined) return null;
  const derived = (getWorkflowDraft(ctx.getDraft()) as { derived_from_skill_id?: string | null })
    .derived_from_skill_id;
  if (derived) return null;
  let overrides: Awaited<ReturnType<AutoSaveDeps["loadPolicies"]>>;
  try {
    overrides = await deps.loadPolicies(ctx.db, ctx.tenant_id, ctx.conversation_id);
  } catch {
    return null;
  }
  if (!autoPreparationProceeds({ tool: "save_workflow_draft", input: payload, overrides })) {
    return null;
  }
  const readiness = await deps.checkReadiness({ ctx, forceCommit: false });
  if (!readiness.ok) return readiness.result;
  const result = await deps.commit({
    ctx,
    reason: "auto_mode_no_prior_approval",
    commitIntentKind: "save_workflow_draft",
  });
  if (!result.ok) return result;
  const data =
    typeof result.data === "object" && result.data !== null
      ? (result.data as Record<string, unknown>)
      : {};
  return {
    ...result,
    data: {
      ...data,
      confirmed: true,
      auto_resolved: true,
      performed: "save_workflow_draft",
      reason:
        "permission_mode=auto: saving an inactive draft needs no confirmation, so the engine saved it without asking. Do not call save_workflow_draft again.",
    },
  };
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
    diff: z.unknown().optional(),
    diffs: z.array(z.object({ label: z.string(), preview: z.string().optional() })).optional(),
    target: z.unknown().optional(),
    destructive: z.boolean().optional(),
    default: z.enum(["approve", "reject"]).optional(),
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
    const confirmIntent = scrubStringsDeep({
      kind: args.kind,
      commit_intent: proposedCommitIntent,
      target: args.target,
    }) as ConfirmIntent;
    const denied = ctx.getDraft().state?.last_denied_intent;
    if (denied?.fingerprint && intentHasDistinguishingAction(confirmIntent)) {
      const candidateFp = authoringIntentFingerprint(confirmIntent, ctx.getDraft());
      if (candidateFp && candidateFp === denied.fingerprint) {
        if (ctx.permission_mode !== "auto") {
          const draft = ctx.getDraft();
          if (draft.state) {
            draft.state.last_denied_intent = null;
            try {
              await ctx.setDraft(draft);
            } catch {}
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
    const autoSaved = await autoModeSaveWithoutPause(
      ctx,
      proposedCommitIntent,
      args.destructive === true,
    );
    if (autoSaved) return autoSaved;
    if (
      ctx.permission_mode === "auto" &&
      args.destructive !== true &&
      proposedCommitIntent === undefined
    ) {
      return {
        ok: true,
        data: {
          confirmed: true,
          auto_resolved: true,
          performed: null,
          reason: `permission_mode=auto skipped ${args.kind} confirmation. Nothing ran; call the action's own tool, which applies its own gate.`,
        },
      };
    }
    const overrideWarning = buildOverrideWarning(proposedCommitIntent);
    const baseSummary = args.summary ?? args.question;
    const summary = overrideWarning ? `${overrideWarning}\n\n${baseSummary}` : baseSummary;
    const partialDiffs =
      args.kind === "partial_diff_approval"
        ? (args.diffs ??
          (proposedCommitIntent?.kind === "apply_workflow_patch" &&
          Array.isArray(proposedCommitIntent.payload.patches)
            ? describePatchOps(proposedCommitIntent.payload.patches)
            : undefined))
        : undefined;
    const saveReadiness =
      proposedCommitIntent?.kind === "save_workflow_draft"
        ? await checkWorkflowSaveReadiness({
            ctx,
            forceCommit: proposedCommitIntent.payload.force_commit === true,
          })
        : null;
    if (saveReadiness && !saveReadiness.ok) return saveReadiness.result;
    const saveVerification = saveReadiness?.ok ? saveReadiness.verification : null;
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
    if (saveVerification) input.verification = saveVerification;
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
