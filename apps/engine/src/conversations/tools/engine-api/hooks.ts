import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("HooksEmptyInput");
const IdInput = z.object({ id: z.string().uuid() }).openapi("HookIdInput");

export const listInboundHooksTool: ConversationTool = {
  name: "list_inbound_hooks",
  description: "List inbound webhook endpoints configured for the tenant.",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx) {
    const rows = await ctx.engineClient.hooks.listInbound();
    return { ok: true, data: { hooks: rows } };
  },
};

export const getInboundHookTool: ConversationTool = {
  name: "get_inbound_hook",
  description: "Fetch one inbound webhook by id.",
  inputSchema: IdInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof IdInput>) {
    const h = await ctx.engineClient.hooks.getInbound(args.id);
    if (!h) return { ok: false, data: { error: "inbound_hook_not_found" } };
    return { ok: true, data: { hook: h } };
  },
};

export const hookReadTools: ConversationTool[] = [listInboundHooksTool, getInboundHookTool];
