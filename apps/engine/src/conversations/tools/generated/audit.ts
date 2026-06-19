import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const QueryInput = z
  .object({
    resource_type: z.string().optional(),
    resource_id: z.string().optional(),
    action: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .openapi("QueryAuditToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetAuditEntryToolInput");

export const queryAuditTool: ConversationTool = {
  name: "list_audit",
  description:
    "Query the audit log for the tenant. Optional filters by resource_type, resource_id, and action.",
  inputSchema: QueryInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = QueryInput.parse(rawArgs);
    const filters: Record<string, string> = {};
    if (args.resource_type) filters.resource_type = args.resource_type;
    if (args.resource_id) filters.resource_id = args.resource_id;
    if (args.action) filters.action = args.action;
    const { items, next_cursor } = await ctx.engineClient.audit.query(
      // biome-ignore lint/suspicious/noExplicitAny: audit query filter shape
      filters as any,
      args.limit !== undefined ? { limit: args.limit } : undefined,
    );
    return { ok: true, data: { entries: items, next_cursor } };
  },
};

export const getAuditEntryTool: ConversationTool = {
  name: "get_audit_entry",
  description: "Fetch a single audit-log entry by id.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const entry = await ctx.engineClient.audit.get(args.id);
    if (!entry) return { ok: false, data: { error: "audit_entry_not_found" } };
    return { ok: true, data: { entry } };
  },
};

export const auditReadTools: ConversationTool[] = [queryAuditTool, getAuditEntryTool];
