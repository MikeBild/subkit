// create_skill — create a new tenant Skill.
//
// Mirrors `create_knowledge_source` / `delete_skill`: call the engine-client
// `skills.create` facet, emit a surface audit, and return the uniform
// { ok, data } envelope. The args arrive already parsed — see the note on
// `ConversationTool.execute`.
//
// The dispatcher now owns MCP RBAC (RBAC_OVERRIDES); the in-execute check
// below stays because the chat surface invokes execute() directly and does
// not route through the dispatcher's descriptor.rbac yet.

import type { z } from "@hono/zod-openapi";
import { CreateSkillSchema } from "../../../../skills/types.ts";
import type { ConversationTool, ToolResult } from "../../index.ts";

const CreateSkillInput = CreateSkillSchema.openapi("CreateSkillToolInput");

export const createSkillTool: ConversationTool = {
  name: "create_skill",
  description: "Create a new tenant skill and record an audit entry.",
  inputSchema: CreateSkillInput,
  category: "tenant_write",
  permission: { action: "skill:write", resourceType: "skill" },
  async execute(ctx, args: z.infer<typeof CreateSkillInput>): Promise<ToolResult> {
    try {
      const skill = await ctx.engineClient.skills.create(args);

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "skill",
        resource_id: skill.id,
        action: "conversation.create_skill",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          before: null,
          after: skill,
        },
      });

      return {
        ok: true,
        data: {
          created: true,
          skill,
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "create_failed", message: msg } };
    }
  },
};
