// approve_* / dismiss_* write tools for skill + patch candidates.

import { z } from "@hono/zod-openapi";
import { approvePatchCandidate } from "../../../../self-healing/candidate-decision.ts";
import {
  AdvisoryCandidateError,
  approveSkillCandidate,
} from "../../../../skill-candidates/service.ts";
import type { ConversationTool } from "../../index.ts";

const IdInput = z.object({ candidate_id: z.string().uuid() }).openapi("CandidateIdInput");

export const approveSkillCandidateTool: ConversationTool = {
  name: "approve_skill_candidate",
  description:
    "Approve a skill candidate and create a draft tenant skill. Activation is a separate permissioned action. Writes audit. Idempotent — already-approved candidates return ok=false.",
  inputSchema: IdInput,
  category: "tenant_write",
  // Closes the capture loop IN the coding session: the client's native
  // destructiveHint dialog is the explicit operator approval and RBAC
  // `skill:write` stays the hard boundary. Without this, the loop's last
  // mile forces a surface switch to `sk learnings review` per approval.
  visible_when_readonly: true,
  // Promotion creates a draft; this tool never implies active knowledge.
  authoring_only: true,
  async execute(ctx, args: z.infer<typeof IdInput>) {
    let out: Awaited<ReturnType<typeof approveSkillCandidate>>;
    try {
      out = await approveSkillCandidate(
        { tenant_id: ctx.tenant_id, candidate_id: args.candidate_id, actor_id: ctx.actor_id },
        ctx.db,
      );
    } catch (err) {
      if (!(err instanceof AdvisoryCandidateError)) throw err;
      return { ok: false, data: { error: "skill_candidate_advisory" } };
    }
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
      metadata: { conversation_id: ctx.conversation_id, skill_id: out.skill_id },
    });
    return {
      ok: true,
      data: { candidate: out.candidate, skill_id: out.skill_id, skill_status: "draft" },
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
