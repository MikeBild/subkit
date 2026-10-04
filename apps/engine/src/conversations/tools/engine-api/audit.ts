import { z } from "@hono/zod-openapi";
import type { AuditQueryFilters } from "../../../audit/index.ts";
import type { ConversationTool } from "../index.ts";

const QueryInput = z
  .object({
    resource_type: z.string().optional(),
    resource_id: z.string().optional(),
    action: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    /** Opaque `next_cursor` from a previous page, passed back verbatim. */
    cursor: z.string().min(1).max(128).optional(),
  })
  .openapi("QueryAuditToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetAuditEntryToolInput");

export const queryAuditTool: ConversationTool = {
  name: "list_audit",
  description:
    "Query the audit log for the tenant, newest first. Optional filters by resource_type, resource_id, and action. A full page returns `next_cursor`; pass it back verbatim as `cursor` for the next page (null means no more entries).",
  inputSchema: QueryInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof QueryInput>) {
    const filters: Partial<Omit<AuditQueryFilters, "tenant_id">> = {};
    if (args.resource_type) filters.resource_type = args.resource_type;
    if (args.resource_id) filters.resource_id = args.resource_id;
    if (args.action) filters.actions = [args.action];
    const { items, next_cursor } = await ctx.engineClient.audit.query(filters, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    });
    return { ok: true, data: { entries: items, next_cursor } };
  },
};

export const getAuditEntryTool: ConversationTool = {
  name: "get_audit_entry",
  description: "Fetch a single audit-log entry by id.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const entry = await ctx.engineClient.audit.get(args.id);
    if (!entry) return { ok: false, data: { error: "audit_entry_not_found" } };
    return { ok: true, data: { entry } };
  },
};

export const auditReadTools: ConversationTool[] = [queryAuditTool, getAuditEntryTool];
