import { z } from "@hono/zod-openapi";

import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("SubscriptionsEmptyInput");
const IdInput = z.object({ id: z.string().uuid() }).openapi("SubscriptionIdInput");

export const listSubscriptionsTool: ConversationTool = {
  name: "list_subscriptions",
  description: "List outbound webhook subscriptions.",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx) {
    const rows = await ctx.engineClient.subscriptions.list();
    return { ok: true, data: { subscriptions: rows } };
  },
};

export const getSubscriptionTool: ConversationTool = {
  name: "get_subscription",
  description: "Fetch one subscription by id.",
  inputSchema: IdInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof IdInput>) {
    const s = await ctx.engineClient.subscriptions.get(args.id);
    if (!s) return { ok: false, data: { error: "subscription_not_found" } };
    return { ok: true, data: { subscription: s } };
  },
};

export const subscriptionReadTools: ConversationTool[] = [
  listSubscriptionsTool,
  getSubscriptionTool,
];
