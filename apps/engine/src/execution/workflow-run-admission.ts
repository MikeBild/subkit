import { isDeepStrictEqual } from "node:util";
import { z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { waitForCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { JsonValueSchema } from "../workflows/types.ts";
import { admitAuthorizedWorkflowExecution } from "./authority-admission.ts";
import { authorizationContextFromPrincipal } from "./authorization-context.ts";
import { bindCallerBudget, reserveCallerBudget } from "./caller-budget.ts";
import { assertExecutionPrivacySupported, callerFromPrincipal } from "./caller-context.ts";
import { validateAgainstJsonSchema } from "./engine/envelope.ts";
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

export async function admitWorkflowRun(
  raw: unknown,
  db: Db,
  principal?: import("../auth/types.ts").ResolvedPrincipal | null,
  workflowPermission?: import("./workflow-permission.ts").WorkflowPermission | null,
) {
  const input = schema.parse(raw);
  if (
    input.expected_workflow_version_id &&
    input.workflow_version_id &&
    input.expected_workflow_version_id !== input.workflow_version_id
  ) {
    fail(
      "execution_boundary_mismatch",
      "the prepared workflow version differs from the requested workflow version",
    );
  }
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
  if (input.hold_writes === true && input.execution_authority_id) {
    fail(
      "execution_boundary_mismatch",
      "a preparation request cannot also select a live authority",
    );
  }
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
      const code = (error as { code?: string }).code;
      if (
        input.execution_authority_id ||
        input.hold_writes === false ||
        ![
          "execution_authority_required",
          "execution_authority_unavailable",
          "execution_authority_changed",
          "workflow_version_not_active",
          "execution_boundary_mismatch",
        ].includes(code ?? "")
      )
        throw error;
      if (input.expected_workflow_version_id) throw error;
      downgraded_from = { code: code ?? "", message: (error as Error).message };
    }
  }
  if (resolved.def.input_schema) {
    const check = validateAgainstJsonSchema(normalized, resolved.def.input_schema, "$input");
    if (!check.valid) fail("input_schema_violation", check.errors.join("; "));
  }
  return db.transaction(async (tx) => {
    await waitForCatalogVocabulary(tx, input.tenant_id);
    if (input.idempotency_key) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.tenant_id}:${input.idempotency_key}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, input.tenant_id),
            eq(executions.idempotency_key, input.idempotency_key),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          !existing.hold_writes ||
          existing.execution_authority_id ||
          existing.workflow_id !== input.workflow_id ||
          existing.workflow_version_id !== resolved.workflow_version_id ||
          existing.execution_mode !== input.execution_environment ||
          (existing.parent_execution_id ?? null) !== (input.parent_execution_id ?? null) ||
          !isDeepStrictEqual(existing.caller_context, caller) ||
          existing.caller_origin !== (caller ? "principal" : "unknown") ||
          !isDeepStrictEqual(
            recoverExecutionPayload(existing.input, input.tenant_id, existing.id),
            normalized,
          )
        ) {
          fail(
            "execution_boundary_mismatch",
            "the idempotency key belongs to a different execution boundary",
          );
        }
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
