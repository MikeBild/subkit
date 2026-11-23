import { z } from "@hono/zod-openapi";
import { actorOf } from "../../../../audit/actor.ts";
import { approvePatchCandidate } from "../../../../self-healing/candidate-decision.ts";
import {
  approvalFailureOf,
  approveSkillCandidate,
  getSkillCandidate,
  rejectSkillCandidate,
} from "../../../../skill-candidates/service.ts";
import type { ConversationTool, ToolContext, ToolPrecheck, ToolResult } from "../../index.ts";
import { checkTenantPermission } from "../../permission-gate.ts";
import {
  type GateCard,
  resolveGateSubjects,
  unresolvedGateSubjects,
} from "../../sdk-wrap/gate-subjects.ts";

const IdInput = z.object({ candidate_id: z.string().uuid() }).openapi("CandidateIdInput");

const MAX_APPROVE_BATCH = 100;

const reviewDigest = z.string().regex(/^[a-f0-9]{64}$/);

const ApproveSkillInput = z
  .object({
    candidate_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_APPROVE_BATCH)
      .optional()
      .describe("Proposed skill candidates to approve; one confirmation covers the batch."),
    candidate_id: z
      .string()
      .uuid()
      .optional()
      .describe("A single proposed skill candidate. Prefer candidate_ids."),
    expected_review_digest: reviewDigest
      .optional()
      .describe(
        "Review digest of the candidate the person confirmed. The engine binds it at the confirmation; leave it out.",
      ),
    expected_review_digests: z
      .record(z.string().uuid(), reviewDigest)
      .optional()
      .describe(
        "Review digest per candidate the person confirmed. The engine binds them at the confirmation; leave it out.",
      ),
  })
  .refine((input) => input.candidate_id !== undefined || input.candidate_ids !== undefined, {
    message: "pass candidate_ids (or a single candidate_id)",
  })
  .openapi("ApproveSkillCandidateInput");

type ApproveSkillArgs = z.infer<typeof ApproveSkillInput>;

export function approveCandidateIds(args: {
  candidate_ids?: readonly string[] | undefined;
  candidate_id?: string | undefined;
}): string[] {
  return [
    ...new Set([...(args.candidate_ids ?? []), ...(args.candidate_id ? [args.candidate_id] : [])]),
  ];
}

type ApproveOutcome = "approved" | "not_found" | "already_decided" | "changed_since_review";

export interface ApproveBatchDeps {
  approve: typeof approveSkillCandidate;
  current: typeof getSkillCandidate;
  permit: typeof checkTenantPermission;
}

const APPROVE_BATCH_DEPS: ApproveBatchDeps = {
  approve: approveSkillCandidate,
  current: getSkillCandidate,
  permit: checkTenantPermission,
};

type ApprovedSkill = NonNullable<Awaited<ReturnType<typeof approveSkillCandidate>>>;

async function approveOne(
  ctx: ToolContext,
  candidateId: string,
  digest: string | undefined,
  deps: ApproveBatchDeps,
): Promise<
  { outcome: "approved"; out: ApprovedSkill } | { outcome: Exclude<ApproveOutcome, "approved"> }
> {
  const out = await deps.approve(
    {
      tenant_id: ctx.tenant_id,
      candidate_id: candidateId,
      actor: ctx.principal ? actorOf(ctx.principal) : null,
      ...(digest ? { expected_review_digest: digest } : {}),
    },
    ctx.db,
  );
  if (out) {
    await ctx.engineClient.audit_write({
      resource_type: "skill_candidate",
      resource_id: candidateId,
      action: "conversation.approve_skill_candidate",
      result: "success",
      metadata: { conversation_id: ctx.conversation_id, skill_id: out.skill_id },
    });
    return { outcome: "approved", out };
  }
  const current = await deps.current(ctx.tenant_id, candidateId, ctx.db);
  const outcome = approvalFailureOf(current);
  await ctx.engineClient.audit_write({
    resource_type: "skill_candidate",
    resource_id: candidateId,
    action: "conversation.approve_skill_candidate",
    result: "error",
    reason: outcome,
    metadata: { conversation_id: ctx.conversation_id },
  });
  return { outcome };
}

const SINGLE_FAILURE_MESSAGES: Record<Exclude<ApproveOutcome, "approved">, string> = {
  changed_since_review:
    "The skill candidate changed after the confirmation was shown. Nothing was approved; show the current candidate and ask again.",
  not_found: "The skill candidate no longer exists. Nothing was approved.",
  already_decided: "The skill candidate was already decided. Nothing was approved.",
};

export async function approveSkillCandidates(
  ctx: ToolContext,
  args: ApproveSkillArgs,
  deps: ApproveBatchDeps = APPROVE_BATCH_DEPS,
): Promise<ToolResult> {
  const ids = approveCandidateIds(args);
  for (const candidateId of ids) {
    const gate = await deps.permit(ctx, "skill:write", {
      type: "skill_candidate",
      id: candidateId,
    });
    if (!gate.allow) {
      return {
        ok: false,
        data: { error: "permission_denied", permission: gate.permission, reason: gate.reason },
      };
    }
  }
  const digestFor = (candidateId: string): string | undefined =>
    args.expected_review_digests?.[candidateId] ??
    (ids.length === 1 ? args.expected_review_digest : undefined);

  const [onlyId] = ids;
  if (ids.length === 1 && onlyId) {
    const single = await approveOne(ctx, onlyId, digestFor(onlyId), deps);
    if (single.outcome !== "approved") {
      const message = SINGLE_FAILURE_MESSAGES[single.outcome];
      return {
        ok: false,
        error_code: single.outcome,
        message,
        data: { error: single.outcome, message },
      };
    }
    return {
      ok: true,
      data: {
        candidate: single.out.candidate,
        skill_id: single.out.skill_id,
        skill_status: "draft",
        activation_required: true,
        message: `Created the skill "${single.out.candidate.title}" as a draft. It is not used until someone activates it.`,
      },
    };
  }

  const results: Array<{ candidate_id: string; outcome: ApproveOutcome; skill_id?: string }> = [];
  for (const candidateId of ids) {
    const item = await approveOne(ctx, candidateId, digestFor(candidateId), deps);
    results.push(
      item.outcome === "approved"
        ? { candidate_id: candidateId, outcome: "approved", skill_id: item.out.skill_id }
        : { candidate_id: candidateId, outcome: item.outcome },
    );
  }
  const count = (kind: ApproveOutcome) => results.filter((r) => r.outcome === kind).length;
  const data = {
    results,
    approved: count("approved"),
    not_found: count("not_found"),
    already_decided: count("already_decided"),
    changed_since_review: count("changed_since_review"),
    skill_status: "draft" as const,
    activation_required: true,
  };
  if (data.approved > 0) {
    return {
      ok: true,
      data: {
        ...data,
        message: `Created ${data.approved} draft skill${data.approved === 1 ? "" : "s"}. They are not used until someone activates them.`,
      },
    };
  }
  const error =
    data.changed_since_review > 0
      ? "changed_since_review"
      : data.not_found > 0
        ? "not_found"
        : "already_decided";
  const message = `Nothing was approved: ${data.changed_since_review} changed after the confirmation, ${data.not_found} no longer exist and ${data.already_decided} were already decided. Show the current candidates with list_skill_candidates and ask again.`;
  return {
    ok: false,
    error_code: error,
    message,
    data: { ...data, error, message },
    next_best_actions: ["list_skill_candidates"],
  };
}

function unresolvedRefusal(tool: string, card: GateCard): ToolResult | null {
  const { not_found, already_decided } = unresolvedGateSubjects(tool, card);
  if (not_found.length === 0 && already_decided.length === 0) return null;
  const code = not_found.length > 0 ? "not_found" : "already_decided";
  const parts: string[] = [];
  if (not_found.length > 0)
    parts.push(
      `These ids are not detected skill candidates in this tenant: ${not_found.join(", ")}. Collected learnings are intake items; use the intake tools for them.`,
    );
  if (already_decided.length > 0)
    parts.push(
      `These skill candidates are no longer proposed and were already decided: ${already_decided.join(", ")}.`,
    );
  const message = `Nothing ran and nobody was asked to confirm it. ${parts.join(" ")} Look the candidates up with list_skill_candidates and retry only with proposed ids.`;
  return {
    ok: false,
    error_code: code,
    message,
    data: { error: code, not_found, already_decided, message },
    next_best_actions: ["list_skill_candidates"],
  };
}

async function refuseUnresolved(
  tool: string,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolPrecheck> {
  const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const card = await resolveGateSubjects(tool, raw, ctx.tenant_id, ctx.db);
  const refusal = card ? unresolvedRefusal(tool, card) : null;
  return refusal ? { ok: false, result: refusal } : { ok: true };
}

export const approveSkillCandidateTool: ConversationTool = {
  name: "approve_skill_candidate",
  description:
    "Approve one or more patterns the engine detected (proposed skill candidates; 1-100 ids in candidate_ids, one confirmation covers the batch). Each becomes a draft tenant skill that stays unused until someone activates it (a separate permissioned action). Collected learnings from sessions and conversations are intake items, not skill candidates: review them with the intake tools; a person admits them in the Cockpit. The confirmation shows the target and each candidate's stored title and excerpt; a candidate that changes before it is confirmed is not approved (changed_since_review). Unknown ids fail with not_found and decided ones with already_decided, both before anyone is asked to confirm. A batch returns a result per candidate. Writes audit per candidate.",
  inputSchema: ApproveSkillInput,
  category: "tenant_write",
  visible_when_readonly: true,
  authoring_only: true,
  permission: {
    action: "skill:write",
    resourceType: "skill_candidate",
    resolveResourceId: async (_ctx, rawArgs) =>
      approveCandidateIds({
        candidate_ids: Array.isArray(rawArgs.candidate_ids)
          ? rawArgs.candidate_ids.filter((id): id is string => typeof id === "string")
          : undefined,
        candidate_id: typeof rawArgs.candidate_id === "string" ? rawArgs.candidate_id : undefined,
      })[0] ?? null,
  },
  precheck: (ctx, args) => refuseUnresolved("approve_skill_candidate", ctx, args),
  execute: (ctx, args: ApproveSkillArgs) => approveSkillCandidates(ctx, args),
};

const MAX_REJECT_BATCH = 100;

const RejectInput = z
  .object({
    candidate_ids: z.array(z.string().uuid()).min(1).max(MAX_REJECT_BATCH),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .openapi("RejectSkillCandidatesInput");

type RejectResultOutcome = "rejected" | "not_found" | "already_decided";

export const rejectSkillCandidateTool: ConversationTool = {
  name: "reject_skill_candidate",
  description:
    "Reject one or more patterns the engine detected (proposed skill candidates; 1-100 ids, one confirmation covers the batch; the engine shows each candidate's stored title). Collected learnings are intake items: discard them with discard_intake_items. Rejected candidates never become skills; the proposal stays on record as decided. Unknown ids fail the whole call with not_found and candidates no longer proposed with already_decided, both before anyone is asked to confirm. Writes audit per candidate.",
  inputSchema: RejectInput,
  category: "tenant_write",
  visible_when_readonly: true,
  authoring_only: true,
  permission: {
    action: "skill:write",
    resourceType: "skill_candidate",
    resolveResourceId: async (_ctx, rawArgs) => {
      const ids = rawArgs.candidate_ids;
      return Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : null;
    },
  },
  precheck: (ctx, args) => refuseUnresolved("reject_skill_candidate", ctx, args),
  async execute(ctx, args: z.infer<typeof RejectInput>) {
    const ids = [...new Set(args.candidate_ids)];
    for (const candidateId of ids) {
      const gate = await checkTenantPermission(ctx, "skill:write", {
        type: "skill_candidate",
        id: candidateId,
      });
      if (!gate.allow) {
        return {
          ok: false,
          data: { error: "permission_denied", permission: gate.permission, reason: gate.reason },
        };
      }
    }
    const actorType = ctx.principal?.kind ?? (ctx.actor_id === null ? "system" : "unknown");
    const results: Array<{ candidate_id: string; outcome: RejectResultOutcome }> = [];
    for (const candidateId of ids) {
      const outcome = await rejectSkillCandidate(
        {
          tenant_id: ctx.tenant_id,
          candidate_id: candidateId,
          actor_id: ctx.actor_id,
          actor_type: actorType,
          ...(args.reason ? { reason: args.reason } : {}),
        },
        ctx.db,
      );
      await ctx.engineClient.audit_write({
        resource_type: "skill_candidate",
        resource_id: candidateId,
        action: "conversation.reject_skill_candidate",
        result: outcome.kind === "rejected" ? "success" : "error",
        ...(outcome.kind === "rejected" ? {} : { reason: outcome.kind }),
        metadata: { conversation_id: ctx.conversation_id },
      });
      results.push({ candidate_id: candidateId, outcome: outcome.kind });
    }
    const count = (kind: RejectResultOutcome) => results.filter((r) => r.outcome === kind).length;
    const rejectedCount = count("rejected");
    const notFoundCount = count("not_found");
    const alreadyDecidedCount = count("already_decided");
    const data = {
      results,
      rejected: rejectedCount,
      not_found: notFoundCount,
      already_decided: alreadyDecidedCount,
    };
    if (rejectedCount > 0) return { ok: true, data };
    const error = notFoundCount > 0 ? "not_found" : "already_decided";
    const message = `Nothing was rejected. The confirmed skill candidates changed before the rejection ran: ${notFoundCount} no longer exist and ${alreadyDecidedCount} were already decided. Look them up with list_skill_candidates before trying again.`;
    return {
      ok: false,
      error_code: error,
      message,
      data: { ...data, error, message },
      next_best_actions: ["list_skill_candidates"],
    };
  },
};

const PatchApprovalInput = IdInput.extend({
  expected_review_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe(
      "Digest the human reviewed: from preview_patch_candidate for the whole repair, from dry_run_patch_candidate for a part of it",
    ),
  accepted_operations: z
    .array(z.number().int().min(0))
    .min(1)
    .optional()
    .describe(
      "Indices of the changes the human accepted; needs a dry run of exactly these first. Omit to apply the whole repair",
    ),
});

export const approvePatchCandidateTool: ConversationTool = {
  name: "approve_patch_candidate",
  description: "Apply a proposed patch candidate, creating a new workflow version. Writes audit.",
  inputSchema: PatchApprovalInput,
  category: "tenant_write",
  async execute(ctx, args: z.infer<typeof PatchApprovalInput>) {
    try {
      const newVersionId = await approvePatchCandidate(
        {
          tenant_id: ctx.tenant_id,
          candidate_id: args.candidate_id,
          actor_id: ctx.actor_id,
          actor_type: ctx.principal?.kind ?? (ctx.actor_id === null ? "system" : "unknown"),
          expected_review_digest: args.expected_review_digest,
          accepted_operations: args.accepted_operations,
        },
        ctx.db,
      );
      if (!newVersionId) {
        await ctx.engineClient.audit_write({
          resource_type: "patch_candidate",
          resource_id: args.candidate_id,
          action: "conversation.approve_patch_candidate",
          result: "error",
          reason: "candidate not found or not in proposed state",
          metadata: { conversation_id: ctx.conversation_id },
        });
        return { ok: false, data: { error: "patch_candidate_not_actionable" } };
      }
      await ctx.engineClient.audit_write({
        resource_type: "patch_candidate",
        resource_id: args.candidate_id,
        action: "conversation.approve_patch_candidate",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          workflow_version_id: newVersionId,
        },
      });
      return { ok: true, data: { workflow_version_id: newVersionId } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.engineClient.audit_write({
        resource_type: "patch_candidate",
        resource_id: args.candidate_id,
        action: "conversation.approve_patch_candidate",
        result: "error",
        reason: msg,
        metadata: { conversation_id: ctx.conversation_id },
      });
      return { ok: false, data: { error: msg } };
    }
  },
};
