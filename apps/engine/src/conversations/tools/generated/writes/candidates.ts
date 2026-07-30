// approve_* / dismiss_* write tools for skill + patch candidates.

import { z } from "@hono/zod-openapi";
import { approvePatchCandidate } from "../../../../self-healing/candidate-decision.ts";
import { approveSkillCandidate } from "../../../../skill-candidates/service.ts";
import type { ConversationTool } from "../../index.ts";

const IdInput = z.object({ candidate_id: z.string().uuid() }).openapi("CandidateIdInput");

export const approveSkillCandidateTool: ConversationTool = {
  name: "approve_skill_candidate",
  description:
    "Approve a skill candidate and promote it to a tenant skill. Writes audit. Idempotent — already-approved candidates return ok=false.",
  inputSchema: IdInput,
  category: "tenant_write",
  // Closes the capture loop IN the coding session: the client's native
  // destructiveHint dialog is the explicit operator approval and RBAC
  // `skill:write` stays the hard boundary. Without this, the loop's last
  // mile forces a surface switch to `sk learnings review` per approval.
  visible_when_readonly: true,
  // …but approval PRODUCES a skill — an active definition the engine then
  // grounds itself on. `save_learning` files the candidate and is harmless
  // without this step; this step is the one that changes what the tenant
  // knows. So it rides with the authoring tiers, and a read-and-execute
  // credential approves through `sk skill-candidates approve` instead.
  authoring_only: true,
  async execute(ctx, args: z.infer<typeof IdInput>) {
    const out = await approveSkillCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: args.candidate_id, actor_id: ctx.actor_id },
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
      metadata: { conversation_id: ctx.conversation_id, skill_id: out.skill_id },
    });
    return { ok: true, data: { candidate: out.candidate, skill_id: out.skill_id } };
  },
};

export const approvePatchCandidateTool: ConversationTool = {
  name: "approve_patch_candidate",
  description: "Apply a proposed patch candidate, creating a new workflow version. Writes audit.",
  inputSchema: IdInput,
  category: "tenant_write",
  async execute(ctx, args: z.infer<typeof IdInput>) {
    try {
      const newVersionId = await approvePatchCandidate(
        {
          tenant_id: ctx.tenant_id,
          candidate_id: args.candidate_id,
          actor_id: ctx.actor_id,
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
