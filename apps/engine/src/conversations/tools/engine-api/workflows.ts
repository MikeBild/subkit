import { z } from "@hono/zod-openapi";
import { listedDescription } from "../../../api/catalog-metadata.ts";
import { listTransactionalMailReceipts } from "../../../execution/index.ts";
import { bindingFor, workflowTriggerView } from "../../../scheduler/trigger-bindings.ts";
import { getWorkflowDraft } from "../../../workflows/drafts.ts";
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
        "Only workflows in this catalog block (reported as `category` on every item). Categories are shared with connectors, knowledge sources, skills and files — read one from a previous list rather than inventing one.",
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
    include_draft: z
      .boolean()
      .optional()
      .describe(
        "Also return the saved inactive draft as `draft` (version_id, version, digest, full definition). Pass `draft.version_id` as expected_draft_version_id when saving changes to it.",
      ),
  })
  .refine((v) => Boolean(v.id || v.slug), { message: "Either id or slug is required" })
  .openapi("GetWorkflowToolInput");

export const listWorkflowsTool: ConversationTool = {
  name: "list_workflows",
  description:
    "List the tenant's workflows — returns the COMPLETE set by default (workflows are a bounded catalog). Each item carries what it is for (`description`), the catalog block it belongs to (`category`) and the `connectors` it uses; `category` and `connector` are filters. `effective_trigger` says what really starts the workflow (a bound schedule or webhook beats the definition's declared trigger; `declared_unbound` means declared but nothing fires it); `schedule` is the bound schedule, if any. `total` is the exact tenant count under the given filters; `has_more` is true only when an explicit limit/offset page was requested.",
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
    const [connectorRefs, bindings] = await Promise.all([
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
          description: listedDescription(w.description),
          lifecycle: w.lifecycle,
          category: w.category,
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
    "Fetch a single workflow by id or slug. `definition` is the active version; pass include_draft to also read the saved inactive draft with its version id. `effective_trigger` says what really starts it (a bound schedule or webhook beats the definition's declared `trigger`); `schedule` is the bound schedule, if any. Transactional email workflows also include their newest durable mail receipts, without applicant data. attempted or delivery_unknown never authorizes resend.",
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
    const receipts = wf.definition.steps.some(
      (step) => step.kind === "request" && step.transactional_delivery,
    )
      ? await listTransactionalMailReceipts(ctx.db, ctx.tenant_id, wf.id)
      : undefined;
    const draft = args.include_draft ? await getWorkflowDraft(ctx.tenant_id, wf.id, ctx.db) : null;
    return {
      ok: true,
      data: {
        workflow: {
          ...wf,
          ...(receipts ? { transactional_mail_receipts: receipts } : {}),
          ...workflowTriggerView(wf.definition.trigger, bindingFor(bindings, wf.id)),
        },
        ...(args.include_draft
          ? {
              draft: draft
                ? {
                    version_id: draft.version_id,
                    version: draft.version,
                    digest: draft.digest,
                    is_active: draft.version_id === draft.current_version_id,
                    definition: draft.definition,
                  }
                : null,
            }
          : {}),
      },
    };
  },
};

export const workflowReadTools: ConversationTool[] = [listWorkflowsTool, getWorkflowTool];
