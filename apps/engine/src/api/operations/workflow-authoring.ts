import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { RecipeOriginSchema, recipeAuditMetadata } from "../../workflows/draft-schemas.ts";
import { prepareWorkflowSave } from "../../workflows/prepare-save.ts";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  updateWorkflow,
} from "../../workflows/service.ts";
import { TriggerSchema } from "../../workflows/types.ts";
import type { WorkflowView } from "../../workflows/view.ts";
import { CategorySchema, DescriptionSchema } from "../catalog-metadata.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";
import { automationReadinessFor } from "./workflow-automation-readiness.ts";
import {
  pinRecipeInputs,
  recipeOriginRejection,
  serializeOne,
  WorkflowDetailSchema,
} from "./workflow-representation.ts";
import { AutomationReadinessSchema } from "./workflow-schedule-representation.ts";

const CreateBody = z
  .object({
    name: z.string(),
    slug: z.string().optional(),
    description: DescriptionSchema.optional(),
    category: CategorySchema.optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())),
    timeout_ms: z.number().int().positive().optional(),
    max_llm_tokens_per_run: z.number().int().positive().optional(),
    trigger: TriggerSchema.optional(),
    output_transform: z.string().optional(),
    output_transform_function: z.string().optional(),
    validation_expression: z.string().optional(),
    validation_function: z.string().optional(),
    response_filters: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .openapi("CreateWorkflowBody");

const CreateRequestBody = CreateBody.extend({
  recipe: RecipeOriginSchema.optional(),
  id: z.string().uuid().optional().openapi({
    description:
      "Operator-chosen workflow id, for a client that addresses the workflow by a fixed id. Admins only; unique per installation.",
  }),
}).openapi("CreateWorkflowRequest");

const WorkflowSaveResponse = WorkflowDetailSchema.extend({
  automation_readiness: AutomationReadinessSchema.optional(),
}).openapi("WorkflowSaveResponse");

const ValidateBody = CreateBody.omit({ category: true })
  .extend({ name: z.string().optional() })
  .openapi("ValidateWorkflowBody");

const ValidateResponse = z
  .object({
    ok: z.boolean(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi("ValidateWorkflowResponse");

type WorkflowBody = z.infer<typeof CreateBody>;
type CreateRequest = z.infer<typeof CreateRequestBody>;
type ValidateRequest = z.infer<typeof ValidateBody>;

interface WorkflowSaved {
  readonly workflow: WorkflowView;
  readonly readiness: Awaited<ReturnType<typeof automationReadinessFor>>;
}

function preserveOmittedTrigger(body: WorkflowBody, existing: WorkflowView): WorkflowBody {
  if (Object.hasOwn(body, "trigger") || !existing.definition.trigger) return body;
  return { ...body, trigger: existing.definition.trigger };
}

export const createWorkflowOperation = defineOperation<CreateRequest, WorkflowSaved>({
  id: "workflows.create",
  summary: "Create a workflow",
  permission: "workflow:write",
  effect: "write",
  audit: AuditAction.WORKFLOW_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const { category, recipe, id: chosenId, ...authored } = body;
    const refused = recipe ? recipeOriginRejection(recipe, authored) : null;
    if (refused) return refused;
    const pinned = recipe ? pinRecipeInputs(recipe, authored) : { definition: authored };
    if (pinned.rejection) return pinned.rejection;
    const def = pinned.definition;
    if (chosenId && !principal.roles.includes("admin"))
      return reject.forbidden("only an admin may choose a workflow id");
    const result = await createWorkflow(
      {
        tenant_id: scope.tenant_id,
        def,
        ...(chosenId ? { workflow_id: chosenId } : {}),
        ...(pinned.binding_id ? { trigger_binding_id: pinned.binding_id } : {}),
        actor_id: principal.id,
        actor_type: principal.kind,
        ...(category !== undefined ? { metadata: { category } } : {}),
        ...(recipe ? { audit_metadata: recipeAuditMetadata(recipe) } : {}),
      },
      scope.db,
    );
    if ("errors" in result) return reject.badRequest("invalid workflow", { errors: result.errors });
    return {
      workflow: result.workflow,
      readiness: await automationReadinessFor(
        scope.db,
        scope.tenant_id,
        result.workflow,
        "workflow_save",
      ),
    };
  },
  http: {
    method: "post",
    path: "/v1/workflows",
    tags: ["workflows"],
    body: CreateRequestBody,
    response: WorkflowSaveResponse,
    success: { status: 201, description: "Created" },
    errors: {
      400: "Bad request",
      422: "The recipe origin names no shipped recipe, the definition was not built from it, or an install input is missing or invalid",
    },
    toInput: ({ json }) => json as CreateRequest,
    toBody: async ({ workflow, readiness }, scope) => ({
      ...(await serializeOne(workflow, scope.tenant_id, scope.db)),
      automation_readiness: readiness,
    }),
  },
});

export const validateWorkflowOperation = defineOperation<
  ValidateRequest,
  z.infer<typeof ValidateResponse>
>({
  id: "workflows.validate",
  summary:
    "Validate a workflow definition (structural + step schema). Does not persist; returns errors inline.",
  permission: "workflow:read",
  effect: "read",
  async handler(scope, body) {
    const res = await prepareWorkflowSave(body, scope.tenant_id, scope.db, {
      destinationTier: "tokens",
    });
    if (res.ok) return { ok: true };
    return { ok: false, errors: res.issues };
  },
  http: {
    method: "post",
    path: "/v1/workflows/validate",
    tags: ["workflows"],
    body: ValidateBody,
    response: ValidateResponse,
    toInput: ({ json }) => json as ValidateRequest,
    toBody: (result) => result,
  },
});

interface WorkflowUpdateInput {
  readonly id: string;
  readonly body: WorkflowBody;
}

export const updateWorkflowOperation = defineOperation<WorkflowUpdateInput, WorkflowSaved>({
  id: "workflows.update",
  summary: "Update a workflow",
  permission: "workflow:write",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_UPDATED,
  async handler(scope, { id, body: request }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const { category, ...body } = request;
    const existing = await getWorkflow(scope.tenant_id, id, scope.db);
    if (!existing) return reject.notFound("workflow");
    const result = await updateWorkflow(
      {
        tenant_id: scope.tenant_id,
        id,
        def: preserveOmittedTrigger(body, existing),
        actor_id: principal.id,
        actor_type: principal.kind,
        ...(category !== undefined ? { metadata: { category } } : {}),
      },
      scope.db,
    );
    if ("errors" in result) {
      if (result.errors[0] === "workflow not found") return reject.notFound("workflow");
      return reject.badRequest("invalid workflow", { errors: result.errors });
    }
    return {
      workflow: result.workflow,
      readiness: await automationReadinessFor(
        scope.db,
        scope.tenant_id,
        result.workflow,
        "workflow_save",
      ),
    };
  },
  http: {
    method: "put",
    path: "/v1/workflows/{id}",
    tags: ["workflows"],
    params: IdParam,
    body: CreateBody,
    response: WorkflowSaveResponse,
    errors: { 400: "Bad request", 404: "Not found" },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      body: json as WorkflowBody,
    }),
    toBody: async ({ workflow, readiness }, scope) => ({
      ...(await serializeOne(workflow, scope.tenant_id, scope.db)),
      automation_readiness: readiness,
    }),
  },
});

export const deleteWorkflowOperation = defineOperation<string, "deleted">({
  id: "workflows.delete",
  summary: "Delete a workflow",
  permission: "workflow:delete",
  resource: { type: "workflow", param: "id" },
  effect: "write",
  audit: AuditAction.WORKFLOW_DELETED,
  async handler(scope, id) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const ok = await deleteWorkflow(scope.tenant_id, id, principal.id, scope.db, principal.kind);
    return ok ? "deleted" : reject.notFound("workflow");
  },
  http: {
    method: "delete",
    path: "/v1/workflows/{id}",
    tags: ["workflows"],
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => (param as { id: string }).id,
    toBody: () => null,
  },
});
