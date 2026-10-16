import { z } from "@hono/zod-openapi";
import { createCandidateFromAuthoring } from "../../../../skill-candidates/service.ts";
import type { ConversationTool, ToolResult } from "../../index.ts";

const CreateSkillInput = z
  .object({
    scope: z.enum(["global", "connector", "workflow"]),
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    title: z.string().min(1),
    body: z.string().min(1),
    examples: z.array(z.string()).optional(),
    best_practices: z.array(z.string()).optional(),
    pitfalls: z.array(z.string()).optional(),
    doc_refs: z.array(z.string()).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.scope === "connector" && !input.connector_id) {
      ctx.addIssue({ code: "custom", message: "connector skill requires connector_id" });
    }
    if (input.scope === "workflow" && !input.workflow_id) {
      ctx.addIssue({ code: "custom", message: "workflow skill requires workflow_id" });
    }
    if (input.scope === "global" && (input.connector_id || input.workflow_id)) {
      ctx.addIssue({
        code: "custom",
        message: "global skill must not set connector_id or workflow_id",
      });
    }
    if (input.connector_id && input.workflow_id) {
      ctx.addIssue({
        code: "custom",
        message: "skill cannot set both connector_id and workflow_id",
      });
    }
  })
  .openapi("CreateSkillToolInput");

export const createSkillTool: ConversationTool = {
  name: "create_skill",
  description:
    "Propose a new tenant skill as a PROPOSED candidate for human review. Nothing is " +
    "created or active after this call: it only files a candidate, and no skill exists " +
    "until an operator approves it (approve_skill_candidate in this session, or " +
    "`sk learnings review`). Report it as 'proposed', never as 'created'. Re-proposing IDENTICAL content dedups " +
    "onto the existing candidate; revised content files a fresh candidate next to it.",
  inputSchema: CreateSkillInput,
  category: "tenant_write",
  inert_proposal: true,
  permission: { action: "skill:write", resourceType: "skill" },
  use_case:
    "The user asks to propose, suggest or draft a skill — global, or for a connector or workflow (pass its id).",
  important_notes: [
    "This is how a skill is proposed from a conversation: call it yourself. Never send the user to the REST API, a curl command, or an admin for a skill proposal.",
  ],
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = CreateSkillInput.parse(rawArgs);
    try {
      const result = await createCandidateFromAuthoring({
        tenant_id: ctx.tenant_id,
        title: args.title,
        body: args.body,
        scope: args.scope,
        ...(args.connector_id ? { connector_id: args.connector_id } : {}),
        ...(args.workflow_id ? { workflow_id: args.workflow_id } : {}),
        ...(args.examples ? { examples: args.examples } : {}),
        ...(args.best_practices ? { best_practices: args.best_practices } : {}),
        ...(args.pitfalls ? { pitfalls: args.pitfalls } : {}),
        ...(args.doc_refs ? { doc_refs: args.doc_refs } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
        evidence_summary: `explicit create_skill (conversation=${ctx.conversation_id})`,
        db: ctx.db,
      });
      return {
        ok: true,
        data: {
          created: false,
          action: result.action,
          candidate_id: result.candidate_id,
          note:
            result.action === "skipped"
              ? "An identical proposal was already reviewed (approved or rejected) — nothing new was queued."
              : "Proposed, not created: this only queued a skill candidate for human review. No skill exists and nothing is active until it is approved — approve it right here (call approve_skill_candidate when the user asks), decline it with reject_skill_candidate, or use `sk learnings review`. Tell the user it is proposed, not created.",
          next_best_actions: [
            "approve_skill_candidate",
            "reject_skill_candidate",
            "list_skill_candidates",
          ],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "propose_failed", message: msg } };
    }
  },
};
