// Workflow read tools — list_workflows, get_workflow, get_workflow_by_slug.

import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

// Workflows are a bounded catalog: no server-side default cap — an
// unqualified call returns the COMPLETE set (the 1000 max is a safety
// bound, not a page size). The result is self-describing
// (`total`/`returned`/`offset`/`has_more`) so the model can never
// mistake a page for the universe.
const ListInput = z
  .object({
    status: z.enum(["draft", "active", "archived"]).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .openapi("ListWorkflowsToolInput");

const GetInput = z
  .object({
    id: z.string().uuid("workflow id must be a UUID").optional(),
    slug: z.string().optional(),
  })
  .refine((v) => Boolean(v.id || v.slug), { message: "Either id or slug is required" })
  .openapi("GetWorkflowToolInput");

export const listWorkflowsTool: ConversationTool = {
  name: "list_workflows",
  description:
    "List the tenant's workflows — returns the COMPLETE set by default (workflows are a bounded catalog). `total` is the exact tenant count under the given filters; `has_more` is true only when an explicit limit/offset page was requested.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const offset = args.offset ?? 0;
    const { rows, total } = await ctx.engineClient.workflows.list({
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    });
    return {
      ok: true,
      data: {
        items: rows.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          lifecycle: w.lifecycle,
          created_at: w.created_at,
          updated_at: w.updated_at,
        })),
        total,
        returned: rows.length,
        offset,
        has_more: offset + rows.length < total,
      },
    };
  },
};

export const getWorkflowTool: ConversationTool = {
  name: "get_workflow",
  description: "Fetch a single workflow by id or slug.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof GetInput>) {
    let wf: Awaited<ReturnType<typeof ctx.engineClient.workflows.get>> | null = null;
    if (args.id) {
      wf = await ctx.engineClient.workflows.get(args.id);
    } else if (args.slug) {
      wf = await ctx.engineClient.workflows.getBySlug(args.slug);
    }
    if (!wf) return { ok: false, data: { error: "workflow_not_found" } };
    return { ok: true, data: { workflow: wf } };
  },
};

export const workflowReadTools: ConversationTool[] = [listWorkflowsTool, getWorkflowTool];
