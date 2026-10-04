import { z } from "@hono/zod-openapi";
import { bindingFor, workflowTriggerView } from "../../../scheduler/trigger-bindings.ts";
import { UNCATEGORIZED } from "../../../workflows/categorize.ts";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    status: z.enum(["draft", "active", "archived"]).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
    category: z
      .string()
      .optional()
      .describe(
        "Only workflows in this catalog block. Blocks are derived from the slug families already in the catalog and reported as `category` on every item — read one from a previous list rather than inventing one.",
      ),
    connector: z
      .string()
      .optional()
      .describe(
        "Only workflows whose current version uses this connector (id or slug), counting both a bound connector_id and a ${connector.<slug>.base_url} url.",
      ),
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
    "List the tenant's workflows — returns the COMPLETE set by default (workflows are a bounded catalog). Each item carries a `category` (the catalog block it belongs to) and the `connectors` it uses, and both are filterable. `effective_trigger` says what really starts the workflow (a bound schedule or webhook beats the definition's declared trigger; `declared_unbound` means declared but nothing fires it); `schedule` is the bound schedule, if any. `total` is the exact tenant count under the given filters; `has_more` is true only when an explicit limit/offset page was requested.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const offset = args.offset ?? 0;
    const { rows, total } = await ctx.engineClient.workflows.list({
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.category !== undefined ? { category: args.category } : {}),
      ...(args.connector !== undefined ? { connector: args.connector } : {}),
    });
    const [categories, connectorRefs, bindings] = await Promise.all([
      ctx.engineClient.workflows.categories(),
      ctx.engineClient.workflows.connectorRefs(),
      ctx.engineClient.workflows.triggerBindings(rows.map((w) => w.id)),
    ]);
    return {
      ok: true,
      data: {
        items: rows.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          lifecycle: w.lifecycle,
          category: categories.get(w.slug) ?? UNCATEGORIZED,
          connectors: connectorRefs.get(w.id) ?? [],
          ...workflowTriggerView(w.definition.trigger, bindingFor(bindings, w.id)),
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
  description:
    "Fetch a single workflow by id or slug. `effective_trigger` says what really starts it (a bound schedule or webhook beats the definition's declared `trigger`); `schedule` is the bound schedule, if any.",
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
    const bindings = await ctx.engineClient.workflows.triggerBindings([wf.id]);
    return {
      ok: true,
      data: {
        workflow: {
          ...wf,
          ...workflowTriggerView(wf.definition.trigger, bindingFor(bindings, wf.id)),
        },
      },
    };
  },
};

export const workflowReadTools: ConversationTool[] = [listWorkflowsTool, getWorkflowTool];
