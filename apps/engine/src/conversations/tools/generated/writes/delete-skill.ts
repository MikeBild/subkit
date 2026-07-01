// delete_skill — hard-delete a tenant Skill by id.
//
// Mirrors `delete_knowledge_source` (cleanup.ts): parse the id, call the
// engine-client `skills.delete` facet, emit a surface audit, and return the
// uniform { ok, data } envelope. The service hard-deletes the row (no
// soft-delete) — operators should prefer archiving the skill instead.
//
// The dispatcher now owns MCP RBAC (RBAC_OVERRIDES); the in-execute check
// below stays because the chat surface invokes execute() directly and does
// not route through the dispatcher's descriptor.rbac yet.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "../../index.ts";

const DeleteSkillInput = z.object({ id: z.string().uuid() }).openapi("DeleteSkillToolInput");

export const deleteSkillTool: ConversationTool = {
  name: "delete_skill",
  description:
    "Hard-delete a skill by id — the row is permanently removed (prefer archiving instead). Requires confirmation first and records audit.",
  inputSchema: DeleteSkillInput,
  category: "tenant_write",
  permission: { action: "skill:delete", resourceType: "skill", resourceIdArg: "id" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = DeleteSkillInput.parse(rawArgs);

    try {
      const ok = await ctx.engineClient.skills.delete(args.id);
      if (!ok) {
        return {
          ok: false,
          data: { error: "not_found", message: `Skill ${args.id} not found` },
        };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "skill",
        resource_id: args.id,
        action: "conversation.delete_skill",
        result: "success",
        metadata: { conversation_id: ctx.conversation_id },
      });

      return {
        ok: true,
        data: {
          deleted: true,
          id: args.id,
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "delete_failed", message: msg } };
    }
  },
};
