import { z } from "@hono/zod-openapi";
import { actorOf } from "../../../../audit/actor.ts";
import { approvePatchCandidate } from "../../../../self-healing/candidate-decision.ts";
import {
  approveSkillCandidate,
  getSkillCandidate,
  rejectSkillCandidate,
} from "../../../../skill-candidates/service.ts";
import type { ConversationTool } from "../../index.ts";
import { checkTenantPermission } from "../../permission-gate.ts";

const IdInput = z.object({ candidate_id: z.string().uuid() }).openapi("CandidateIdInput");

export const approveSkillCandidateTool: ConversationTool = {
  name: "approve_skill_candidate",
  description:
    "Approve a skill candidate. A practice or detected pattern becomes a draft tenant skill (activation is a separate permissioned action); a fact (`knowledge_learning`) is appended to the domain's knowledge source as a new version. Writes audit. Idempotent — already-approved candidates return ok=false.",
  inputSchema: IdInput,
  category: "tenant_write",
  visible_when_readonly: true,
  authoring_only: true,
  async execute(ctx, args: z.infer<typeof IdInput>) {
    const pending = await getSkillCandidate(ctx.tenant_id, args.candidate_id, ctx.db);
    const fact = pending?.pattern_kind === "knowledge_learning";
    if (fact) {
      const gate = await checkTenantPermission(ctx, "knowledge:write", {
        type: "skill_candidate",
        id: args.candidate_id,
      });
      if (!gate.allow) {
        return {
          ok: false,
          data: { error: "permission_denied", permission: gate.permission, reason: gate.reason },
        };
      }
    }
    const out = await approveSkillCandidate(
      {
        tenant_id: ctx.tenant_id,
        candidate_id: args.candidate_id,
        actor: ctx.principal ? actorOf(ctx.principal) : null,
        may_write_knowledge: fact,
      },
      ctx.db,
    );
    if (!out) {
      await ctx.engineClient.audit_write({
        resource_type: "skill_candidate",
        resource_id: args.candidate_id,
        action: "conversation.approve_skill_candidate",
        result: "error",
        reason: "candidate not found or not in proposed state",
        metadata: { conversation_id: ctx.conversation_id },
      });
      return { ok: false, data: { error: "skill_candidate_not_actionable" } };
    }
    await ctx.engineClient.audit_write({
      resource_type: "skill_candidate",
      resource_id: args.candidate_id,
      action: "conversation.approve_skill_candidate",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        ...(out.skill_id ? { skill_id: out.skill_id } : {}),
        ...(out.knowledge ? { knowledge_source_id: out.knowledge.knowledge_source_id } : {}),
      },
    });
    return {
      ok: true,
      data: out.knowledge
        ? { candidate: out.candidate, knowledge: out.knowledge }
        : { candidate: out.candidate, skill_id: out.skill_id, skill_status: "draft" },
    };
  },
};

const MAX_REJECT_BATCH = 100;

const RejectInput = z
  .object({
    candidate_ids: z.array(z.string().uuid()).min(1).max(MAX_REJECT_BATCH),
    titles: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(MAX_REJECT_BATCH)
      .describe(
        "Candidate titles in the same order as candidate_ids, shown to the person before they confirm",
      ),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.titles.length === v.candidate_ids.length, {
    message: "titles must have one entry per candidate_ids entry",
    path: ["titles"],
  })
  .openapi("RejectSkillCandidatesInput");

export const rejectSkillCandidateTool: ConversationTool = {
  name: "reject_skill_candidate",
  description:
    "Reject one or more proposed skill candidates (1-100 ids with one title each, one confirmation covers the batch). Rejected candidates never become skills or knowledge; the proposal stays on record as decided. Only candidates still in the proposed state are rejected — others are reported as not_actionable. Writes audit per candidate.",
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
    const results: Array<{ candidate_id: string; outcome: "rejected" | "not_actionable" }> = [];
    for (const candidateId of ids) {
      const rejected = await rejectSkillCandidate(
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
        result: rejected ? "success" : "error",
        ...(rejected ? {} : { reason: "candidate not found or not in proposed state" }),
        metadata: { conversation_id: ctx.conversation_id },
      });
      results.push({
        candidate_id: candidateId,
        outcome: rejected ? "rejected" : "not_actionable",
      });
    }
    const rejectedCount = results.filter((r) => r.outcome === "rejected").length;
    return {
      ok: rejectedCount > 0,
      data: {
        results,
        rejected: rejectedCount,
        not_actionable: results.length - rejectedCount,
        ...(rejectedCount === 0 ? { error: "skill_candidate_not_actionable" } : {}),
      },
    };
  },
};

const PatchApprovalInput = IdInput.extend({
  expected_review_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("Digest from preview_patch_candidate reviewed by the human"),
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
