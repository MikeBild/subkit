import { z } from "@hono/zod-openapi";
import { WORKFLOW_OPERATING_STATUSES } from "@shared/workflow-operating-status.ts";
import { AuditAction } from "../../audit/types.ts";
import { listTransactionalMailReceipts } from "../../execution/index.ts";
import { can } from "../../rbac/evaluator.ts";
import { workflowTriggerView } from "../../scheduler/trigger-bindings.ts";
import type { ListWorkflowsOptions } from "../../workflows/catalog-view.ts";
import { getWorkflowDraft } from "../../workflows/drafts.ts";
import { workflowIdBySlug } from "../../workflows/lookup.ts";
import {
  loadWorkflowCategoryBlocks,
  loadWorkflowDetail,
  loadWorkflowList,
  type WorkflowDetailEntry,
  type WorkflowListEntry,
} from "../../workflows/read-model.ts";
import { updateWorkflowMetadata } from "../../workflows/service.ts";
import type { WorkflowView } from "../../workflows/view.ts";
import {
  AcceptDescriptionSchema,
  CatalogGroupBySchema,
  CategorySchema,
  DescriptionSchema,
  descriptionAcceptanceValid,
  listedDescription,
} from "../catalog-metadata.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, isRejection, type OperationScope, reject } from "./index.ts";
import {
  serializeOne,
  serializeWorkflowDetail,
  toWorkflowListItem,
  WorkflowDetailSchema,
  WorkflowListResponse,
} from "./workflow-representation.ts";

const ListWorkflowsQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    status: z.enum(["draft", "active", "archived"]).optional(),
    operating_status: z.enum(WORKFLOW_OPERATING_STATUSES).optional(),
    name_contains: z.string().optional(),
    q: z.string().min(1).max(200).optional(),
    sort: z.enum(["name", "lifecycle", "created_at", "updated_at"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    group_by: CatalogGroupBySchema.optional(),
    description_source: z.enum(["llm", "human"]).optional(),
    category: z
      .string()
      .optional()
      .describe("Only workflows in this catalog block (see the `category` field on each item)"),
    connector: z
      .string()
      .optional()
      .describe("Only workflows whose current version uses this connector (id or slug)"),
  })
  .openapi("ListWorkflowsQuery");

const ListWorkflowsToolInput = z
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

const GetWorkflowToolInput = z
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

const WorkflowMetadataPatchBody = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: DescriptionSchema.nullable().optional(),
    accept_description: AcceptDescriptionSchema.optional(),
    category: CategorySchema.nullable().optional(),
    lifecycle: z.enum(["active", "archived"]).optional(),
  })
  .refine(descriptionAcceptanceValid, {
    message: "accept_description requires the exact nonempty description",
    path: ["accept_description"],
  })
  .openapi("WorkflowMetadataPatchBody");

type ListQuery = z.infer<typeof ListWorkflowsQuery>;
type ListToolArgs = z.infer<typeof ListWorkflowsToolInput>;
type GetToolArgs = z.infer<typeof GetWorkflowToolInput>;
type MetadataPatch = z.infer<typeof WorkflowMetadataPatchBody>;

type WorkflowCategoryBlock = Awaited<ReturnType<typeof loadWorkflowCategoryBlocks>>[number];
type WorkflowLookup = Parameters<typeof loadWorkflowDetail>[1];

interface WorkflowListInput {
  readonly options: ListWorkflowsOptions;
  readonly catalog: boolean;
}

interface WorkflowListResult {
  readonly entries: WorkflowListEntry[];
  readonly total: number;
  readonly categories: WorkflowCategoryBlock[];
}

async function operatingAccess(scope: OperationScope) {
  const principal = scope.principal;
  const may = async (permission: "schedule:read" | "inbound_hook:read" | "connector:read") =>
    principal
      ? (await can(scope.db, { tenant_id: scope.tenant_id, principal, permission, quiet: true }))
          .allow
      : false;
  const [schedules, hooks, connectors] = await Promise.all([
    may("schedule:read"),
    may("inbound_hook:read"),
    may("connector:read"),
  ]);
  return { schedules, hooks, connectors };
}

function listOptionsFromQuery(q: ListQuery): ListWorkflowsOptions {
  const opts: ListWorkflowsOptions = {};
  if (q.limit !== undefined) opts.limit = q.limit;
  if (q.offset !== undefined) opts.offset = q.offset;
  if (q.status !== undefined) opts.status = q.status;
  if (q.operating_status !== undefined) opts.operating_status = q.operating_status;
  if (q.name_contains !== undefined) opts.name_contains = q.name_contains;
  if (q.q !== undefined) opts.q = q.q;
  if (q.sort !== undefined) opts.sort = q.sort;
  if (q.order !== undefined) opts.order = q.order;
  if (q.group_by !== undefined) opts.group_by = q.group_by;
  if (q.category !== undefined) opts.category = q.category;
  if (q.description_source) opts.description_source = q.description_source;
  if (q.connector !== undefined) opts.connector = q.connector;
  return opts;
}

function toToolListItem(entry: WorkflowListEntry) {
  const w = entry.workflow;
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    description: listedDescription(w.description),
    lifecycle: w.lifecycle,
    category: w.category,
    connectors: entry.connectors,
    ...workflowTriggerView(w.definition.trigger, entry.binding),
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

export const listWorkflowsOperation = defineOperation<WorkflowListInput, WorkflowListResult>({
  id: "workflows.list",
  summary: "List workflows",
  permission: "workflow:read",
  effect: "read",
  async handler(scope, { options, catalog }) {
    if (!catalog) {
      const { entries, total } = await loadWorkflowList(scope.tenant_id, options, scope.db);
      return { entries, total, categories: [] };
    }
    const operating = {
      include_operating_status: true,
      operating_access: await operatingAccess(scope),
    };
    const [{ entries, total }, categories] = await Promise.all([
      loadWorkflowList(scope.tenant_id, { ...options, ...operating }, scope.db),
      loadWorkflowCategoryBlocks(scope.tenant_id, scope.db),
    ]);
    return { entries, total, categories };
  },
  http: {
    method: "get",
    path: "/v1/workflows",
    tags: ["workflows"],
    query: ListWorkflowsQuery,
    response: WorkflowListResponse,
    toInput: ({ query }) => ({ options: listOptionsFromQuery(query as ListQuery), catalog: true }),
    toBody: ({ entries, total, categories }) => ({
      items: entries.map(toWorkflowListItem),
      total,
      categories,
    }),
  },
  tool: {
    name: "list_workflows",
    description:
      "List the tenant's workflows — returns the COMPLETE set by default (workflows are a bounded catalog). Each item carries what it is for (`description`), the catalog block it belongs to (`category`) and the `connectors` it uses; `category` and `connector` are filters. `effective_trigger` says what really starts the workflow (a bound schedule or webhook beats the definition's declared trigger; `declared_unbound` means declared but nothing fires it); `schedule` is the bound schedule, if any. `total` is the exact tenant count under the given filters; `has_more` is true only when an explicit limit/offset page was requested.",
    input: ListWorkflowsToolInput,
    gate: "enforced",
    resourceType: "workflow",
    toInput: (raw) => {
      const args = raw as ListToolArgs;
      return {
        options: {
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.connector !== undefined ? { connector: args.connector } : {}),
        },
        catalog: false,
      };
    },
    toResult: (outcome, { options }) => {
      if (isRejection(outcome)) return { ok: false, data: { error: outcome.code } };
      const offset = options.offset ?? 0;
      return {
        ok: true,
        data: {
          items: outcome.entries.map(toToolListItem),
          total: outcome.total,
          returned: outcome.entries.length,
          offset,
          has_more: offset + outcome.entries.length < outcome.total,
        },
      };
    },
  },
});

interface WorkflowGetInput {
  readonly lookup: WorkflowLookup;
  readonly include_draft: boolean;
  readonly include_receipts: boolean;
}

interface WorkflowGetResult {
  readonly entry: WorkflowDetailEntry;
  readonly receipts?: Awaited<ReturnType<typeof listTransactionalMailReceipts>>;
  readonly draft?: Awaited<ReturnType<typeof getWorkflowDraft>>;
}

export const getWorkflowOperation = defineOperation<WorkflowGetInput, WorkflowGetResult>({
  id: "workflows.get",
  summary: "Fetch a workflow",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, { lookup, include_draft, include_receipts }) {
    const entry = await loadWorkflowDetail(scope.tenant_id, lookup, scope.db);
    if (!entry) return reject.notFound("workflow");
    const wf = entry.workflow;
    const receipts =
      include_receipts &&
      wf.definition.steps.some((step) => step.kind === "request" && step.transactional_delivery)
        ? await listTransactionalMailReceipts(scope.db, scope.tenant_id, wf.id)
        : undefined;
    if (!include_draft) return { entry, ...(receipts ? { receipts } : {}) };
    const draft = await getWorkflowDraft(scope.tenant_id, wf.id, scope.db);
    return { entry, ...(receipts ? { receipts } : {}), draft };
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}",
    tags: ["workflows"],
    params: IdParam,
    response: WorkflowDetailSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({
      lookup: { id: (param as { id: string }).id },
      include_draft: false,
      include_receipts: false,
    }),
    toBody: ({ entry }) => serializeWorkflowDetail(entry.workflow, entry.binding),
  },
  tool: {
    name: "get_workflow",
    description:
      "Fetch a single workflow by id or slug. `definition` is the active version; pass include_draft to also read the saved inactive draft with its version id. `effective_trigger` says what really starts it (a bound schedule or webhook beats the definition's declared `trigger`); `schedule` is the bound schedule, if any. Transactional email workflows also include their newest durable mail receipts, without applicant data. attempted or delivery_unknown never authorizes resend.",
    input: GetWorkflowToolInput,
    gate: "enforced",
    resolveResourceId: async (ctx, args) => {
      if (typeof args.id === "string" && args.id.length > 0) return args.id;
      if (typeof args.slug === "string" && args.slug.length > 0)
        return workflowIdBySlug(ctx.db, ctx.tenant_id, args.slug);
      return null;
    },
    toInput: (raw) => {
      const args = raw as GetToolArgs;
      return {
        lookup: args.id ? { id: args.id } : { slug: args.slug ?? "" },
        include_draft: Boolean(args.include_draft),
        include_receipts: true,
      };
    },
    toResult: (outcome, { include_draft }) => {
      if (isRejection(outcome)) return { ok: false, data: { error: "workflow_not_found" } };
      const { entry, receipts, draft } = outcome;
      const wf = entry.workflow;
      return {
        ok: true,
        data: {
          workflow: {
            ...wf,
            ...(receipts ? { transactional_mail_receipts: receipts } : {}),
            ...workflowTriggerView(wf.definition.trigger, entry.binding),
          },
          ...(include_draft
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
  },
});

interface WorkflowMetadataInput {
  readonly id: string;
  readonly patch: MetadataPatch;
}

export const updateWorkflowMetadataOperation = defineOperation<WorkflowMetadataInput, WorkflowView>(
  {
    id: "workflows.update_metadata",
    summary:
      "Patch workflow metadata (slug/name/description/category/lifecycle) without rotating a version",
    permission: "workflow:write",
    resource: { type: "workflow", param: "id" },
    effect: "write",
    audit: AuditAction.WORKFLOW_UPDATED,
    async handler(scope, { id, patch: body }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const result = await updateWorkflowMetadata(
        {
          tenant_id: scope.tenant_id,
          id,
          actor_id: principal.id,
          actor_type: principal.kind,
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.accept_description !== undefined
            ? { accept_description: body.accept_description }
            : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.lifecycle !== undefined ? { lifecycle: body.lifecycle } : {}),
        },
        scope.db,
      );
      if ("workflow" in result && result.workflow) return result.workflow;
      if (result.code) {
        return reject.conflict(
          result.errors[0] ?? "lifecycle change not allowed",
          { errors: result.errors },
          result.code,
        );
      }
      if (result.conflict) {
        return reject.conflict("slug already in use by a live workflow", {
          errors: result.errors,
          conflict: result.conflict,
        });
      }
      if (result.errors[0] === "workflow not found") return reject.notFound("workflow");
      return reject.badRequest("invalid workflow metadata", { errors: result.errors });
    },
    http: {
      method: "patch",
      path: "/v1/workflows/{id}/metadata",
      tags: ["workflows"],
      params: IdParam,
      body: WorkflowMetadataPatchBody,
      response: WorkflowDetailSchema,
      errors: { 400: "Bad request", 404: "Not found", 409: "Slug or description conflict" },
      toInput: ({ param, json }) => ({
        id: (param as { id: string }).id,
        patch: json as MetadataPatch,
      }),
      toBody: (workflow, scope) => serializeOne(workflow, scope.tenant_id, scope.db),
    },
  },
);
