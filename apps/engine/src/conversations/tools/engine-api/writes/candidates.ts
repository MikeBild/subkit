import { z } from "@hono/zod-openapi";
import { approvePatchCandidate } from "../../../../self-healing/candidate-decision.ts";
import { approveSkillCandidate, getSkillCandidate } from "../../../../skill-candidates/service.ts";
import type { ConversationTool } from "../../index.ts";
import { checkTenantPermission } from "../../permission-gate.ts";
import { toolActor } from "../../tool-actor.ts";

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
        actor: toolActor(ctx),
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
