import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("TunnelsEmptyInput");
const IdInput = z.object({ id: z.string().uuid() }).openapi("TunnelIdInput");

export const listTunnelsTool: ConversationTool = {
  name: "list_tunnels",
  description: "List registered tunnel endpoints.",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx) {
    const rows = await ctx.engineClient.tunnels.list();
    return { ok: true, data: { tunnels: rows } };
  },
};

export const getTunnelTool: ConversationTool = {
  name: "get_tunnel",
  description: "Fetch one tunnel by id.",
  inputSchema: IdInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const t = await ctx.engineClient.tunnels.get(args.id);
    if (!t) return { ok: false, data: { error: "tunnel_not_found" } };
    return { ok: true, data: { tunnel: t } };
  },
};

export const tunnelReadTools: ConversationTool[] = [listTunnelsTool, getTunnelTool];
