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
  async execute(ctx, args: z.infer<typeof DeleteSkillInput>): Promise<ToolResult> {
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
