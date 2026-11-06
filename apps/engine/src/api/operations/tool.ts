import type { ConversationTool } from "../../conversations/tools/index.ts";
import type { Operation, OperationScope } from "./index.ts";

export function toConversationTool<I, R>(op: Operation<I, R>): ConversationTool {
  const tool = op.tool;
  if (!tool) throw new Error(`operation ${op.id} has no tool binding`);
  const resource = op.resource;
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.use_case ? { use_case: tool.use_case } : {}),
    ...(tool.important_notes ? { important_notes: tool.important_notes } : {}),
    inputSchema: tool.input,
    category: op.effect === "read" ? "tenant_read" : "tenant_write",
    ...(tool.gate === "enforced"
      ? {
          permission: {
            action: op.permission,
            resourceType: tool.resourceType ?? resource?.type ?? op.id.split(".")[0] ?? op.id,
            ...(tool.resolveResourceId
              ? { resolveResourceId: tool.resolveResourceId }
              : resource
                ? { resourceIdArg: resource.param }
                : {}),
          },
        }
      : {}),
    async execute(ctx, args) {
      const scope: OperationScope = {
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        principal: ctx.principal ?? null,
      };
      const input = tool.toInput(args);
      return tool.toResult(await op.handler(scope, input), input);
    },
  };
}
