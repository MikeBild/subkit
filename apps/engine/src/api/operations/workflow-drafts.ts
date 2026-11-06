import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { assertRecipeOrigin } from "../../http/routes/recipe-origin.ts";
import {
  applyBoundaryProposals,
  currentOrDraftDefinition,
} from "../../workflows/apply-boundary-proposals.ts";
import { proposeBoundaries } from "../../workflows/boundary-proposal.ts";
import {
  CreateWorkflowDraftSchema,
  recipeAuditMetadata,
  UpdateWorkflowDraftSchema,
  WorkflowDraftSchema,
} from "../../workflows/draft-schemas.ts";
import {
  getWorkflowDraft,
  type SaveWorkflowDraftResult,
  saveWorkflowDraft,
} from "../../workflows/drafts.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, isRejection, type Rejection, reject } from "./index.ts";

const draftFailures = {
  400: "Invalid draft",
  401: "Authentication required",
  403: "Permission denied",
  404: "Draft not found",
  409: "Draft, active version or slug changed",
};

const DRAFT_DESCRIPTION = "Inert draft; no activation or execution authority";

const ProposalSchema = z
  .object({
    proposals: z.array(
      z.object({
        step_id: z.string(),
        boundary: z
          .object({
            variables: z.record(z.string(), z.unknown()),
            max_body_bytes: z.number().int(),
            max_calls: z.number().int(),
          })
          .optional(),
        s3_scope: z.object({ key_prefix: z.string(), max_bytes: z.number().int() }).optional(),
        evidence: z.object({
          observations: z.number().int(),
          sample: z.string(),
          newest_at: z.string(),
        }),
      }),
    ),
    unproposable: z.array(z.object({ step_id: z.string(), reason: z.string() })),
  })
  .openapi("WorkflowBoundaryProposals");

const ApplyBoundaryProposalsBody = z
  .object({
    expected_draft_version_id: z.string().uuid().nullable(),
    step_ids: z.array(z.string().min(1)).max(200).optional(),
  })
  .openapi("ApplyBoundaryProposalsBody");

const ApplyBoundaryProposalsResponse = z
  .object({
    draft: WorkflowDraftSchema,
    applied_step_ids: z.array(z.string()),
  })
  .openapi("ApplyBoundaryProposalsResponse");

type CreateDraft = z.infer<typeof CreateWorkflowDraftSchema>;
type UpdateDraft = z.infer<typeof UpdateWorkflowDraftSchema>;
type ApplyBody = z.infer<typeof ApplyBoundaryProposalsBody>;
type Draft = NonNullable<SaveWorkflowDraftResult["draft"]>;
type WorkflowDraft = NonNullable<Awaited<ReturnType<typeof getWorkflowDraft>>>;
type Proposals = Awaited<ReturnType<typeof proposeBoundaries>>;

function unwrap(result: SaveWorkflowDraftResult): Draft | Rejection {
  if (result.draft) return result.draft;
  if (result.code === "not_found") return reject.notFound("workflow");
  if (result.code === "invalid_definition") return reject.badRequest(result.errors.join("; "));
  if (result.code === "human_confirmation_required")
    return reject.status(403, result.code, result.errors.join("; "));
  return reject.conflict(result.errors.join("; "), { reason: result.code, ...result.details });
}

function idOf(param: unknown): string {
  return (param as { id: string }).id;
}

export const createWorkflowDraftOperation = defineOperation<CreateDraft, Draft>({
  id: "workflows.drafts.create",
  summary: "Save a new inert workflow draft without activating triggers",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.WORKFLOW_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    if (body.recipe) assertRecipeOrigin(body.recipe, body.definition);
    const result = await saveWorkflowDraft(
      {
        tenant_id: scope.tenant_id,
        actor_id: principal.id,
        actor_type: principal.kind,
        def: body.definition,
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
        spec_authority: principal,
        request_source: scope.request_source ?? "api",
        ...(body.category !== undefined ? { metadata: { category: body.category } } : {}),
        ...(body.recipe ? { audit_metadata: recipeAuditMetadata(body.recipe) } : {}),
      },
      scope.db,
    );
    return unwrap(result);
  },
  http: {
    method: "post",
    path: "/v1/workflows/drafts",
    tags: ["workflows"],
    body: CreateWorkflowDraftSchema,
    response: WorkflowDraftSchema,
    success: { status: 201, description: DRAFT_DESCRIPTION },
    errors: {
      ...draftFailures,
      422: "The recipe origin names no shipped recipe, or the definition was not built from it",
    },
    toInput: ({ json }) => json as CreateDraft,
    toBody: (draft) => draft,
  },
});

interface UpdateDraftInput {
  readonly id: string;
  readonly body: UpdateDraft;
}

export const updateWorkflowDraftOperation = defineOperation<UpdateDraftInput, Draft>({
  id: "workflows.drafts.update",
  summary: "Save a draft version without changing the active workflow",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_UPDATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const result = await saveWorkflowDraft(
      {
        tenant_id: scope.tenant_id,
        actor_id: principal.id,
        actor_type: principal.kind,
        workflow_id: id,
        expected_draft_version_id: body.expected_draft_version_id,
        ...(body.expected_current_version_id !== undefined
          ? { expected_current_version_id: body.expected_current_version_id }
          : {}),
        def: body.definition,
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
        spec_authority: principal,
        ...(body.category !== undefined ? { metadata: { category: body.category } } : {}),
        request_source: scope.request_source ?? "api",
      },
      scope.db,
    );
    return unwrap(result);
  },
  http: {
    method: "put",
    path: "/v1/workflows/{id}/draft",
    tags: ["workflows"],
    params: IdParam,
    body: UpdateWorkflowDraftSchema,
    response: WorkflowDraftSchema,
    success: { status: 200, description: DRAFT_DESCRIPTION },
    errors: draftFailures,
    toInput: ({ param, json }) => ({ id: idOf(param), body: json as UpdateDraft }),
    toBody: (draft) => draft,
  },
});

export const getWorkflowDraftOperation = defineOperation<string, WorkflowDraft>({
  id: "workflows.drafts.get",
  summary: "Read the exact pending draft, separately from the active version",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, id) {
    const draft = await getWorkflowDraft(scope.tenant_id, id, scope.db);
    return draft ?? reject.notFound("workflow draft");
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/draft",
    tags: ["workflows"],
    params: IdParam,
    response: WorkflowDraftSchema,
    success: { status: 200, description: DRAFT_DESCRIPTION },
    errors: draftFailures,
    toInput: ({ param }) => idOf(param),
    toBody: (draft) => draft,
  },
});

export const workflowBoundaryProposalsOperation = defineOperation<string, Proposals>({
  id: "workflows.boundary_proposals.read",
  summary: "Read the boundaries SubKit derives from what each step has really done",
  permission: "workflow:read",
  resource: { type: "workflow", param: "id" },
  effect: "read",
  async handler(scope, id) {
    const definition = await currentOrDraftDefinition(scope.tenant_id, id, scope.db);
    if (!definition) return reject.notFound("workflow");
    return proposeBoundaries(scope.db, {
      tenant_id: scope.tenant_id,
      workflow_id: id,
      definition,
    });
  },
  http: {
    method: "get",
    path: "/v1/workflows/{id}/boundary-proposals",
    tags: ["workflows"],
    params: IdParam,
    response: ProposalSchema,
    success: { status: 200, description: "Derived from execution history; nothing is changed" },
    errors: draftFailures,
    toInput: ({ param }) => idOf(param),
    toBody: (derived) => derived,
  },
});

interface ApplyInput {
  readonly id: string;
  readonly body: ApplyBody;
}

interface Applied {
  readonly draft: Draft;
  readonly applied_step_ids: string[];
}

export const applyWorkflowBoundaryProposalsOperation = defineOperation<ApplyInput, Applied>({
  id: "workflows.boundary_proposals.apply",
  summary: "Write the derived boundaries into a new draft, activating nothing",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_UPDATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const result = await applyBoundaryProposals(
      {
        tenant_id: scope.tenant_id,
        workflow_id: id,
        expected_draft_version_id: body.expected_draft_version_id,
        ...(body.step_ids ? { step_ids: body.step_ids } : {}),
        actor_id: principal.id,
        actor_type: principal.kind,
        request_source: scope.request_source ?? "api",
      },
      scope.db,
    );
    if (!("applied_step_ids" in result)) {
      if ("code" in result && result.code === "nothing_to_apply")
        return reject.badRequest(
          "nothing could be derived for this workflow: its steps have no recorded history to read",
        );
      const refused = unwrap(result as SaveWorkflowDraftResult);
      if (isRejection(refused)) return refused;
      return reject.badRequest("boundary proposals could not be applied");
    }
    return { draft: result.draft, applied_step_ids: result.applied_step_ids };
  },
  http: {
    method: "post",
    path: "/v1/workflows/{id}/boundary-proposals/apply",
    tags: ["workflows"],
    params: IdParam,
    body: ApplyBoundaryProposalsBody,
    response: ApplyBoundaryProposalsResponse,
    success: { status: 200, description: "A new inert draft carrying the derived boundaries" },
    errors: draftFailures,
    toInput: ({ param, json }) => ({ id: idOf(param), body: json as ApplyBody }),
    toBody: (applied) => applied,
  },
});
