import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { workflowAuthorityExecutionOptions } from "../workflows/execution-authorities.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { assertExecutionAuthorityCurrent } from "./authority-admission.ts";
import { CallerContextSchema, callerFromPrincipal } from "./caller-context.ts";
import { resolveExecutionCallerOrigin } from "./caller-origin.ts";
import { type RunExecutionSource, resolveDefinition } from "./resolve-definition.ts";
import {
  authorizeSensitiveResume,
  isSensitivePayload,
  recoverExecutionPayload,
} from "./sensitive-payload.ts";
import type { RunOptions } from "./types.ts";

export async function bindExistingRun(
  db: Db,
  tenant_id: string,
  source: RunExecutionSource,
  input: unknown,
  options: RunOptions,
): Promise<{ source: RunExecutionSource; options: RunOptions; input: unknown }> {
  if (!options.existing_execution_id) return { source, options, input };
  const [row] = await db
    .select()
    .from(executions)
    .where(
      and(eq(executions.tenant_id, tenant_id), eq(executions.id, options.existing_execution_id)),
    )
    .limit(1);
  const mismatch = () =>
    Object.assign(new Error("execution boundary does not match the persisted run"), {
      code: "execution_boundary_mismatch",
    });
  if (!row) throw mismatch();
  const persistedCaller = row.caller_context ? CallerContextSchema.parse(row.caller_context) : null;
  const persistedCallerOrigin = resolveExecutionCallerOrigin(
    tenant_id,
    row.caller_context,
    row.caller_origin,
  );
  if (persistedCaller && !options.principal) {
    if (isSensitivePayload(row.input))
      throw Object.assign(
        new Error("Sensitive resume requires the original authenticated caller."),
        { code: "sensitive_resume_forbidden" },
      );
    throw mismatch();
  }
  if (
    (persistedCaller &&
      options.principal &&
      !isDeepStrictEqual(
        callerFromPrincipal(options.principal, tenant_id, persistedCaller?.productId ?? undefined),
        persistedCaller,
      )) ||
    (options.caller_context !== undefined &&
      !isDeepStrictEqual(options.caller_context, persistedCaller)) ||
    (options.caller_origin !== undefined && options.caller_origin !== persistedCallerOrigin)
  )
    throw mismatch();
  if (isSensitivePayload(row.input)) {
    await authorizeSensitiveResume(db, row, options.principal, options.resume_authorized === true);
    const persistedInput = recoverExecutionPayload(row.input, tenant_id, row.id);
    if (isDeepStrictEqual(input, row.input) || input === undefined) input = persistedInput;
    options = { ...options, execution_privacy: "sensitive" };
  }
  if (row.hold_writes) {
    options = { ...options, hold_writes: true, self_healing: { enabled: false } };
  }
  if (row.tool_approval_id) {
    if (
      options.hold_writes ||
      options.self_healing?.enabled ||
      options.step_output_fixtures !== undefined ||
      (options.tool_approval_id && options.tool_approval_id !== row.tool_approval_id)
    )
      throw mismatch();
    await assertExecutionAuthorityCurrent(db, tenant_id, row.id);
    options = {
      ...options,
      tool_approval_id: row.tool_approval_id,
      self_healing: { enabled: false },
    };
  }
  if (row.source_kind !== "saved" && source.kind !== "saved")
    return {
      source,
      options: {
        ...options,
        caller_context: persistedCaller,
        caller_origin: persistedCallerOrigin,
      },
      input,
    };
  if (
    row.source_kind !== "saved" ||
    source.kind !== "saved" ||
    !row.workflow_version_id ||
    row.workflow_id !== source.workflow_id ||
    (source.version_id !== undefined && source.version_id !== row.workflow_version_id) ||
    (options.execution_mode !== undefined && options.execution_mode !== row.execution_mode)
  )
    throw mismatch();
  const pinned = await resolveDefinition(db, tenant_id, {
    kind: "saved",
    workflow_id: source.workflow_id,
    version_id: row.workflow_version_id,
  });
  input = normalizeWorkflowRunInput(input, pinned.def.input_schema);
  if (
    !isDeepStrictEqual(
      input,
      normalizeWorkflowRunInput(
        recoverExecutionPayload(row.input, tenant_id, row.id),
        pinned.def.input_schema,
      ),
    )
  )
    throw mismatch();
  if (row.execution_authority_id) {
    if (
      options.self_healing?.enabled ||
      options.hold_writes ||
      options.step_output_fixtures !== undefined
    )
      throw mismatch();
    await assertExecutionAuthorityCurrent(db, tenant_id, row.id);
  }
  return {
    input,
    source: { kind: "saved", workflow_id: source.workflow_id, version_id: row.workflow_version_id },
    options: {
      ...options,
      ...(row.execution_authority_id ? workflowAuthorityExecutionOptions(row.execution_mode) : {}),
      execution_mode: row.execution_mode,
      request_source: RequestSourceSchema.parse(row.request_source),
      parent_execution_id: row.parent_execution_id,
      caller_context: persistedCaller,
      caller_origin: persistedCallerOrigin,
    },
  };
}
