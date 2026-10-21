import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { executionStartTraceId } from "../../../audit/index.ts";
import { KEYSET_CURSOR_PATTERN } from "../../../db/keyset-cursor.ts";
import { executionStatusEnum, executions } from "../../../db/schema/index.ts";
import {
  describeExecutionEvidence,
  executionVisibilityFilter,
  isSensitivePayload,
} from "../../../execution/index.ts";
import { listExecutions } from "../../../execution/list.ts";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z
      .string()
      .min(1)
      .max(128)
      .regex(
        KEYSET_CURSOR_PATTERN,
        "Invalid cursor. Omit cursor for the first page; for later pages copy next_cursor from the previous result without changing it. Keep the same filters.",
      )
      .optional()
      .describe(
        "Omit for the first page. For later pages use only the previous result's non-null next_cursor verbatim, with unchanged filters. Never invent a cursor or use a page number.",
      ),
    workflow_id: z.string().uuid().optional(),
    status: z
      .enum(executionStatusEnum.enumValues)
      .optional()
      .describe("Filter by outcome only when the task requires it; omit to inspect all outcomes."),
    request_source: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Filter by the run's recorded start channel only when requested, not the current chat channel.",
      ),
    started_from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only runs that started at or after this instant (ISO 8601)."),
    started_to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Only runs that started before this instant (ISO 8601, exclusive)."),
  })
  .openapi("ListExecutionsToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetExecutionToolInput");

export const listExecutionsTool: ConversationTool = {
  name: "list_executions",
  description:
    "List recent executions for the tenant (newest first, paged — executions are an unbounded history). Omit cursor on the first page. Use only filters justified by the task; do not invent status, channel or date bounds. When the user names a workflow, first resolve it with get_workflow/find_workflow and pass workflow_id; never treat the tenant-wide latest execution as evidence for a named workflow. started_from/started_to narrow to a window on the start time (the window `get_operating_figures` counts over), status to one outcome. `total` is the exact count under the given filters; while `has_more` is true, pass `next_cursor` back verbatim as `cursor` with unchanged filters for the next page. A failed read is missing evidence, not an empty history.",
  inputSchema: ListInput,
  strict: false,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>) {
    if (!ctx.principal) return { ok: false, data: { error: "principal_required" } };
    const { rows, total, next_cursor } = await listExecutions(
      ctx.tenant_id,
      {
        principal: ctx.principal,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.request_source !== undefined ? { request_source: args.request_source } : {}),
        ...(args.started_from !== undefined ? { started_from: new Date(args.started_from) } : {}),
        ...(args.started_to !== undefined ? { started_to: new Date(args.started_to) } : {}),
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        items: rows.map((e) => ({
          id: e.id,
          ...describeExecutionEvidence(e),
          workflow_id: e.workflow_id,
          status: e.status,
          started_at: e.started_at,
          finished_at: e.finished_at,
        })),
        total,
        returned: rows.length,
        next_cursor,
        has_more: next_cursor !== null,
      },
    };
  },
};

export const getExecutionTool: ConversationTool = {
  name: "get_execution",
  description:
    "Fetch one execution by id (full row including status, timestamps and `caller`: who started it, how SubKit verified them, over which channel, and the originating run for nested runs) plus its structured `outcome`: kind (succeeded / failed / held = writes held in a preview, nothing written / partial = a tolerated step failure / running), the failed step, its cause class and error code, step counts, and the output-contract verdict.",
  inputSchema: GetInput,
  category: "tenant_read",
  permission: { action: "execution:read", resourceType: "execution", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof GetInput>) {
    if (!ctx.principal) return { ok: false, data: { error: "principal_required" } };
    const e = (
      await ctx.db
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, ctx.tenant_id),
            eq(executions.id, args.id),
            executionVisibilityFilter(ctx.principal),
          ),
        )
        .limit(1)
    )[0];
    if (!e) return { ok: false, data: { error: "execution_not_found" } };
    return {
      ok: true,
      data: {
        execution: {
          id: e.id,
          ...describeExecutionEvidence(e),
          workflow_id: e.workflow_id,
          workflow_version_id: e.workflow_version_id,
          status: e.status,
          request_source: e.request_source,
          trace_id: await executionStartTraceId(ctx.db, ctx.tenant_id, e.id),
          parent_execution_id: e.parent_execution_id,
          input: isSensitivePayload(e.input) ? null : e.input,
          started_at: e.started_at,
          finished_at: e.finished_at,
          created_at: e.created_at,
        },
        outcome: await ctx.engineClient.executions.outcome(e),
      },
    };
  },
};

export const executionReadTools: ConversationTool[] = [listExecutionsTool, getExecutionTool];
