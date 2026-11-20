import { z } from "@hono/zod-openapi";
import type { AuditQueryFilters } from "../../../audit/index.ts";
import { AUDIT_CURSOR_PATTERN, serializeAuditEntry } from "../../../audit/index.ts";
import { RequestSourceSchema } from "../../../observability/service-metadata.ts";
import type { ConversationTool } from "../index.ts";

const QueryInput = z
  .object({
    resource_type: z.string().optional(),
    resource_types: z.string().max(2000).optional(),
    resource_id: z.string().optional(),
    action: z.string().optional(),
    actor_id: z.string().uuid().optional(),
    actor_type: z.enum(["user", "system_account", "system", "unknown"]).optional(),
    api_key_id: z.string().uuid().optional(),
    session_id: z.string().uuid().optional(),
    access_type: z
      .enum([
        "api_key",
        "browser_session",
        "mcp_oauth",
        "token_exchange",
        "external_bearer",
        "task_run",
        "portal_token",
      ])
      .optional(),
    oauth_client_id: z
      .string()
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/)
      .optional(),
    request_source: RequestSourceSchema.optional(),
    origin_source: RequestSourceSchema.optional(),
    execution_source: RequestSourceSchema.optional(),
    correlation_id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
    execution_id: z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    task_id: z
      .string()
      .uuid()
      .optional()
      .describe("Everything recorded about one task, including its runs and grants."),
    task_run_id: z.string().uuid().optional().describe("Everything recorded about one task run."),
    result: z.enum(["success", "denied", "error"]).optional(),
    trace_id: z.string().min(1).max(128).optional(),
    ts_from: z.string().datetime().optional(),
    ts_to: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z
      .string()
      .min(1)
      .max(128)
      .regex(
        AUDIT_CURSOR_PATTERN,
        "Invalid cursor. Omit cursor for the first page; for later pages copy next_cursor from the previous result without changing it. Keep the same filters.",
      )
      .optional()
      .describe(
        "Omit for the first page. For later pages use only the previous result's non-null next_cursor verbatim, with unchanged filters. Never invent a cursor or use a page number.",
      ),
  })
  .openapi("QueryAuditToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetAuditEntryToolInput");

export const queryAuditTool: ConversationTool = {
  name: "list_audit",
  description:
    "Query the tenant audit log, newest first. Omit cursor on the first page. Use only filters justified by the task; do not invent action, result, channel or date bounds. `origin_source` is the trusted initiating channel and `execution_source` the immediate server step. Legacy `request_source` is only a recorded value and may be client-declared. Filter by actor, API key/session, access type, OAuth client, resource, result, trace/correlation, run/conversation/workflow/task/task run ID and UTC time bounds. `ts_to` is exclusive. Missing provenance is not inferred. Pass a non-null `next_cursor` back verbatim with unchanged filters for the next page. A failed read is missing evidence, not an empty history.",
  inputSchema: QueryInput,
  strict: false,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof QueryInput>) {
    const filters: Partial<Omit<AuditQueryFilters, "tenant_id">> = {};
    if (args.resource_type) filters.resource_type = args.resource_type;
    if (args.resource_types) {
      filters.resource_types = args.resource_types
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (args.resource_id) filters.resource_id = args.resource_id;
    if (args.action) {
      filters.actions = args.action
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (args.actor_id) filters.actor_id = args.actor_id;
    if (args.actor_type) filters.actor_type = args.actor_type;
    if (args.api_key_id) filters.api_key_id = args.api_key_id;
    if (args.session_id) filters.session_id = args.session_id;
    if (args.access_type) filters.access_type = args.access_type;
    if (args.oauth_client_id) filters.oauth_client_id = args.oauth_client_id;
    if (args.request_source) filters.request_source = args.request_source;
    if (args.origin_source) filters.origin_source = args.origin_source;
    if (args.execution_source) filters.execution_source = args.execution_source;
    if (args.correlation_id) filters.correlation_id = args.correlation_id;
    if (args.execution_id) filters.execution_id = args.execution_id;
    if (args.conversation_id) filters.conversation_id = args.conversation_id;
    if (args.workflow_id) filters.workflow_id = args.workflow_id;
    if (args.task_id) filters.task_id = args.task_id;
    if (args.task_run_id) filters.task_run_id = args.task_run_id;
    if (args.result) filters.result = args.result;
    if (args.trace_id) filters.trace_id = args.trace_id;
    if (args.ts_from) filters.ts_from = new Date(args.ts_from);
    if (args.ts_to) filters.ts_to = new Date(args.ts_to);
    const { items, next_cursor } = await ctx.engineClient.audit.query(filters, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    });
    return { ok: true, data: { entries: items.map(serializeAuditEntry), next_cursor } };
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
    return { ok: true, data: { entry: serializeAuditEntry(entry) } };
  },
};

export const auditReadTools: ConversationTool[] = [queryAuditTool, getAuditEntryTool];
