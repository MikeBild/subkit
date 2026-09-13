import { isDeepStrictEqual } from "node:util";

import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { workflowAuthorityExecutionOptions } from "../workflows/execution-authorities.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { assertExecutionAuthorityCurrent } from "./authority-admission.ts";
import type { RunExecutionSource } from "./resolve-definition.ts";
import type { RunOptions } from "./types.ts";

/** Queue envelopes identify a run; they cannot expand its persisted boundary. */
export async function bindExistingRun(
  db: Db,
  tenant_id: string,
  source: RunExecutionSource,
  input: unknown,
  options: RunOptions,
): Promise<{ source: RunExecutionSource; options: RunOptions }> {
  if (!options.existing_execution_id) return { source, options };
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
  if (row.source_kind !== "saved" && source.kind !== "saved") return { source, options };
  if (
    row.source_kind !== "saved" ||
    source.kind !== "saved" ||
    !row.workflow_version_id ||
    row.workflow_id !== source.workflow_id ||
    (source.version_id !== undefined && source.version_id !== row.workflow_version_id) ||
    (options.execution_mode !== undefined && options.execution_mode !== row.execution_mode) ||
    !isDeepStrictEqual(normalizeWorkflowRunInput(input), normalizeWorkflowRunInput(row.input))
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
    source: { kind: "saved", workflow_id: source.workflow_id, version_id: row.workflow_version_id },
    options: {
      ...options,
      ...(row.execution_authority_id ? workflowAuthorityExecutionOptions(row.execution_mode) : {}),
      execution_mode: row.execution_mode,
      request_source: RequestSourceSchema.parse(row.request_source),
      parent_execution_id: row.parent_execution_id,
    },
  };
}
