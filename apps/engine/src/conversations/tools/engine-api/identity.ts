import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("IdentityEmptyInput");
const IdInput = z.object({ id: z.string().uuid() }).openapi("IdentityIdInput");
const ListUsersInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .openapi("ListUsersToolInput");

export const whoamiTool: ConversationTool = {
  name: "whoami",
  description: "Return the current tenant record and calling actor id.",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx) {
    const tenant = await ctx.engineClient.identity.whoami();
    return {
      ok: true,
      data: { tenant, actor_id: ctx.engineClient.context.actor_id },
    };
  },
};

export const listUsersTool: ConversationTool = {
  name: "list_users",
  description: "List tenant members (human users).",
  inputSchema: ListUsersInput,
  category: "tenant_read",
  permission: { action: "identity:read", resourceType: "user" },
  async execute(ctx, args: z.infer<typeof ListUsersInput>) {
    const users = await ctx.engineClient.identity.listUsers({
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    });
    return { ok: true, data: { users } };
  },
};

export const getUserTool: ConversationTool = {
  name: "get_user",
  description: "Fetch a single user by id.",
  inputSchema: IdInput,
  category: "tenant_read",
  permission: { action: "identity:read", resourceType: "user", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof IdInput>) {
    const u = await ctx.engineClient.identity.getUser(args.id);
    if (!u) return { ok: false, data: { error: "user_not_found" } };
    return { ok: true, data: { user: u } };
  },
};

export const listApiKeysTool: ConversationTool = {
  name: "list_api_keys",
  description: "List API keys for the tenant (metadata only; never the raw secret).",
  inputSchema: EmptyInput,
  category: "tenant_read",
  permission: { action: "api_key:read", resourceType: "api_key" },
  async execute(ctx) {
    const keys = await ctx.engineClient.identity.listApiKeys();
    return { ok: true, data: { api_keys: keys } };
  },
};

export const getApiKeyTool: ConversationTool = {
  name: "get_api_key",
  description: "Fetch API key metadata by id.",
  inputSchema: IdInput,
  category: "tenant_read",
  permission: { action: "api_key:read", resourceType: "api_key", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof IdInput>) {
    const k = await ctx.engineClient.identity.getApiKey(args.id);
    if (!k) return { ok: false, data: { error: "api_key_not_found" } };
    return { ok: true, data: { api_key: k } };
  },
};

export const listPortalTokensTool: ConversationTool = {
  name: "list_portal_tokens",
  description: "List active portal tokens for the tenant.",
  inputSchema: EmptyInput,
  category: "tenant_read",
  permission: { action: "portal_token:read", resourceType: "portal_token" },
  async execute(ctx) {
    const tokens = await ctx.engineClient.identity.listPortalTokens();
    return { ok: true, data: { portal_tokens: tokens } };
  },
};

export const listSystemAccountsTool: ConversationTool = {
  name: "list_system_accounts",
  description: "List system (service) accounts for the tenant.",
  inputSchema: ListUsersInput,
  category: "tenant_read",
  permission: { action: "identity:read", resourceType: "user" },
  async execute(ctx, args: z.infer<typeof ListUsersInput>) {
    const rows = await ctx.engineClient.identity.listSystemAccounts({
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    });
    return { ok: true, data: { system_accounts: rows } };
  },
};

export const identityReadTools: ConversationTool[] = [
  whoamiTool,
  listUsersTool,
  getUserTool,
  listApiKeysTool,
  getApiKeyTool,
  listPortalTokensTool,
  listSystemAccountsTool,
];
