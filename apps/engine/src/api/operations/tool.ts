import type { ConversationTool, ToolContext, ToolResult } from "../../conversations/tools/index.ts";
import {
  actorOfPrincipal,
  type Operation,
  type OperationActor,
  type OperationScope,
} from "./index.ts";

function engineClientActor(ctx: ToolContext): OperationActor {
  const context = ctx.engineClient.context;
  return {
    id: context.actor_id,
    type: context.actor_type ?? (context.actor_id ? "unknown" : "system"),
  };
}

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
    ...(tool.requires_draft !== undefined ? { requires_draft: tool.requires_draft } : {}),
    ...(tool.precheck ? { precheck: tool.precheck } : {}),
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    category: op.effect === "read" ? "tenant_read" : "tenant_write",
    ...(op.permission === null
      ? {}
      : tool.gate === "enforced" && tool.permission
        ? { permission: { action: op.permission, ...tool.permission } }
        : tool.gate === "enforced"
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
      const principal = ctx.principal ?? null;
      const scope: OperationScope = {
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        principal,
        get actor() {
          return principal ? actorOfPrincipal(principal) : engineClientActor(ctx);
        },
      };
      const input = await tool.toInput(args, ctx);
      const run = async (): Promise<ToolResult> => {
        const refused = tool.guard ? await tool.guard(input, ctx) : null;
        if (refused) return refused;
        prepared = tool.prepare ? await tool.prepare(input, ctx) : undefined;
        return tool.toResult(await op.handler(scope, input), input, ctx, prepared);
      };
      let prepared: unknown;
      if (!tool.onError) return run();
      try {
        return await run();
      } catch (error) {
        return tool.onError(error, input, ctx, prepared);
      }
    },
  };
}
