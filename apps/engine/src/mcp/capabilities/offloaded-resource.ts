import { type ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { executionVisibleToPrincipal } from "../../execution/execution-owner.ts";
import { resolveOffloaded } from "../../execution/offload.ts";
import { isSensitivePayload } from "../../execution/sensitive-payload.ts";
import { can } from "../../rbac/evaluator.ts";

const RESOURCE_NOT_FOUND = -32002 as ErrorCode;

export async function readOffloadedExecutionResource(
  db: Db,
  principal: ResolvedPrincipal,
  uri: string,
): Promise<{ executionId: string; body: unknown }> {
  const [execution] = await db
    .select({
      execution_id: executions.id,
      result_sha256: executions.result_sha256,
    })
    .from(executions)
    .where(
      and(eq(executions.tenant_id, principal.tenant_id), eq(executions.result_storage_uri, uri)),
    )
    .limit(1);
  const [step] = execution
    ? []
    : await db
        .select({
          execution_id: executionSteps.execution_id,
          result_sha256: executionSteps.result_sha256,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, principal.tenant_id),
            eq(executionSteps.result_storage_uri, uri),
          ),
        )
        .limit(1);
  const executionId = execution?.execution_id ?? step?.execution_id;
  const resultSha256 = execution?.result_sha256 ?? step?.result_sha256;
  if (!executionId) throw new McpError(RESOURCE_NOT_FOUND, "object resource not found");
  const [owner] = await db
    .select({
      caller: executions.caller_context,
      input: executions.input,
      result: executions.sensitive_result,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, executionId)))
    .limit(1);
  if (
    !owner ||
    !executionVisibleToPrincipal(owner.caller, principal) ||
    isSensitivePayload(owner.input) ||
    isSensitivePayload(owner.result)
  ) {
    throw new McpError(RESOURCE_NOT_FOUND, "object resource not found");
  }

  const decision = await can(db, {
    tenant_id: principal.tenant_id,
    principal,
    permission: "execution:read",
    resource: { type: "execution", id: executionId },
  });
  if (!decision.allow) {
    const error = new Error(decision.reason ?? "permission_denied") as Error & { code?: number };
    error.code = -32001;
    throw error;
  }

  const body = await resolveOffloaded(db, principal.tenant_id, {
    $offloaded: true,
    storage_uri: uri,
    preview: "",
    size_bytes: 0,
    ...(resultSha256 ? { sha256: resultSha256 } : {}),
  });
  return { executionId, body };
}
