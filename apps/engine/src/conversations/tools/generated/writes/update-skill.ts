// update_skill — patch a persisted tenant Skill's authored content
// (title, body, examples, activation rules, gated tools, lifecycle).
// Generic patch shape; send only the fields that should change.
//
// Pattern parity with update_knowledge_source / update_workflow.
//
// The dispatcher now owns MCP RBAC (RBAC_OVERRIDES); the in-execute check
// below stays because the chat surface invokes execute() directly and does
// not route through the dispatcher's descriptor.rbac yet. Audit funnels
// through the conversation.update_skill action with full before/after
// snapshots.

import { z } from "@hono/zod-openapi";
import { UpdateSkillSchema } from "../../../../skills/types.ts";
import type { ConversationTool } from "../../index.ts";

const UpdateSkillInput = z
  .object({ id: z.string().uuid() })
  .merge(UpdateSkillSchema)
  .openapi("UpdateSkillToolInput");

export const updateSkillTool: ConversationTool = {
  name: "update_skill",
  description:
    "Patch a persisted tenant Skill — edit its title/body, examples, best practices, pitfalls, doc refs, gated tools, activation rules, I/O schemas, side-effect/idempotency/maturity metadata, tags, or lifecycle status. Send only the fields that should change.",
  use_case:
    "Use when the user asks to rename a skill, revise its guidance, adjust when it activates, change which tools it gates, or change its lifecycle status. Send only the fields that should change.",
  important_notes: [
    "Send only the fields you want to change — omitted fields are left untouched.",
    "Audits as conversation.update_skill with full before/after snapshots.",
  ],
  inputSchema: UpdateSkillInput,
  category: "tenant_write",
  permission: { action: "skill:write", resourceType: "skill", resourceIdArg: "id" },
  async execute(ctx, rawArgs) {
    const args = UpdateSkillInput.parse(rawArgs);
    const { id, ...patch } = args;

    try {
      const before = await ctx.engineClient.skills.get(id);
      const skill = await ctx.engineClient.skills.update(id, patch);

      if (!skill) {
        return {
          ok: false,
          data: { error: "not_found", message: `Skill ${id} not found` },
        };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "skill",
        resource_id: id,
        action: "conversation.update_skill",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          fields: Object.keys(patch),
          before: before ?? null,
          after: skill,
        },
      });

      return {
        ok: true,
        data: {
          updated: true,
          skill,
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "update_failed", message: msg } };
    }
  },
};
