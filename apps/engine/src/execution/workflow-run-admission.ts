import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { JsonValueSchema } from "../workflows/types.ts";
import { inputSchemaVerdict, lockIdempotentExecution } from "./admission-facts.ts";
import { admitAuthorizedWorkflowExecution } from "./authority-admission.ts";
import { authorizationContextFromPrincipal } from "./authorization-context.ts";
import { bindCallerBudget, reserveCallerBudget } from "./caller-budget.ts";
import { assertExecutionPrivacySupported, callerFromPrincipal } from "./caller-context.ts";
import { type AdmissionDecision, boundaryOfExecution, decideAdmission } from "./core/admission.ts";
import { resolveDefinition } from "./resolve-definition.ts";
import { recoverExecutionPayload } from "./sensitive-payload.ts";
import { createExecution } from "./state.ts";

const schema = z
  .object({
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid().optional(),
    expected_workflow_version_id: z.string().uuid().optional(),
    execution_authority_id: z.string().uuid().optional(),
    execution_environment: z.enum(["dev", "prod"]),
    request_source: RequestSourceSchema,
    input: JsonValueSchema.optional(),
    idempotency_key: z.string().min(1).max(512).optional(),
    parent_execution_id: z.string().uuid().nullable().optional(),
    hold_writes: z.boolean().optional(),
  })
  .strict();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function enforce(decision: AdmissionDecision): AdmissionDecision {
  if (decision.kind === "rejected") fail(decision.code, decision.message);
  return decision;
}

export async function admitWorkflowRun(
  raw: unknown,
  db: Db,
  principal?: import("../auth/types.ts").ResolvedPrincipal | null,
  workflowPermission?: import("./workflow-permission.ts").WorkflowPermission | null,
) {
  const input = schema.parse(raw);
  enforce(decideAdmission(input, { stage: "requested_version" }));
  const [saved] = await db
    .select({ lifecycle: workflows.lifecycle })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, input.workflow_id)))
    .limit(1);
  enforce(decideAdmission(input, { stage: "lifecycle", lifecycle: saved?.lifecycle ?? null }));
  const resolved = await resolveDefinition(db, input.tenant_id, {
    kind: "saved",
    workflow_id: input.workflow_id,
    ...(input.workflow_version_id ? { version_id: input.workflow_version_id } : {}),
  });
  const normalized = JsonValueSchema.parse(
    normalizeWorkflowRunInput(input.input, resolved.def.input_schema) ?? null,
  );
  const caller = callerFromPrincipal(
    principal,
    input.tenant_id,
    resolved.def.product_id,
    resolved.def.required_caller_kind,
  );
  assertExecutionPrivacySupported(input.request_source, resolved.def.execution_privacy);
  enforce(decideAdmission(input, { stage: "binding" }));
  let downgraded_from: { code: string; message: string } | undefined;
  if (input.hold_writes !== true) {
    const {
      hold_writes: _hold,
      expected_workflow_version_id: _expectedWorkflowVersionId,
      ...authorityInput
    } = input;
    try {
      const admitted = await admitAuthorizedWorkflowExecution(
        authorityInput,
        db,
        caller,
        authorizationContextFromPrincipal(principal, workflowPermission, input.workflow_id),
      );
      return { ...admitted, hold_writes: false };
    } catch (error) {
      const fallback = decideAdmission(input, {
        stage: "authority_refusal",
        code: (error as { code?: string }).code ?? null,
        message: (error as Error).message,
      });
      if (fallback.kind !== "downgrade") throw error;
      downgraded_from = fallback.downgraded_from;
    }
  }
  enforce(
    decideAdmission(input, {
      stage: "input",
      verdict: inputSchemaVerdict(normalized, resolved.def.input_schema),
    }),
  );
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, input.tenant_id);
    if (input.idempotency_key) {
      const existing = await lockIdempotentExecution(tx, input.tenant_id, input.idempotency_key);
      if (existing) {
        enforce(
          decideAdmission(input, {
            stage: "replay",
            existing: boundaryOfExecution(
              existing,
              recoverExecutionPayload(existing.input, input.tenant_id, existing.id),
            ),
            requested: {
              binding: "held",
              execution_authority_id: null,
              workflow_id: input.workflow_id,
              workflow_version_id: resolved.workflow_version_id,
              execution_mode: input.execution_environment,
              parent_execution_id: input.parent_execution_id ?? null,
              caller_context: caller,
              caller_origin: caller ? "principal" : "unknown",
              input: normalized,
            },
          }),
        );
        return {
          execution_id: existing.id,
          execution_authority_id: null,
          workflow_version_id: resolved.workflow_version_id,
          input: normalized,
          status: existing.status,
          replayed: true,
          hold_writes: true,
          ...(downgraded_from ? { downgraded_from } : {}),
        };
      }
    }
    const reservation = await reserveCallerBudget(tx, resolved.def, caller, normalized);
    const execution_id = await createExecution(tx, {
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      workflow_version_id: resolved.workflow_version_id,
      source_kind: "saved",
      source_ref: input.parent_execution_id ? { rerun_of: input.parent_execution_id } : null,
      request_source: input.request_source,
      execution_mode: input.execution_environment,
      input: normalized,
      idempotency_key: input.idempotency_key ?? null,
      parent_execution_id: input.parent_execution_id ?? null,
      hold_writes: true,
      caller_context: caller,
      caller_origin: caller ? "principal" : "unknown",
      authorization_context: authorizationContextFromPrincipal(
        principal,
        workflowPermission,
        input.workflow_id,
      ),
      execution_privacy: resolved.def.execution_privacy,
    });
    await bindCallerBudget(tx, input.tenant_id, execution_id, reservation);
    return {
      execution_id,
      execution_authority_id: null,
      workflow_version_id: resolved.workflow_version_id,
      input: normalized,
      status: "queued" as const,
      replayed: false,
      hold_writes: true,
      ...(downgraded_from ? { downgraded_from } : {}),
    };
  });
}
