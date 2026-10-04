// What a refused saved-workflow run answers over HTTP — shared by
// POST /v1/executions and POST /v1/executions/{id}/rerun so the two routes
// can never map the same engine refusal to different answers.

import { actorType } from "../../../audit/index.ts";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import type { Executor } from "../../../db/client.ts";
import { auditAdmissionRefusal } from "../../../execution/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";

/** Codes that are a refusal of THIS run — not a fault of the engine. A
 *  connector that cannot serve the prepared run is one: the operator fixes it
 *  on the connector, and the answer names which one. */
function isRefusal(code: string | undefined): code is string {
  return (
    code !== undefined &&
    (code.startsWith("execution_") ||
      code.startsWith("workflow_version_") ||
      code === "workflow_archived" ||
      code === "prepared_credential_unavailable")
  );
}

/**
 * Turn an engine refusal into its HTTP answer, auditing it on the way; any
 * other error is rethrown unchanged. The refusal's `details` (for a connector:
 * step, connector, environment and reason — never a credential field) travel
 * in the body so a client can say which connector to fix and link to it.
 */
export async function admissionRefusal(
  error: unknown,
  context: {
    db: Executor;
    principal: ResolvedPrincipal;
    workflow_id: string;
    request_source: string;
    /** The row admission already created, when the refusal came after it. */
    execution_id?: string | null;
    extra?: Record<string, unknown>;
  },
): Promise<never> {
  if ((error as Error | undefined)?.message?.startsWith("workflow not found"))
    throw new NotFoundError("workflow");
  const code = (error as { code?: string }).code;
  if (code === "input_schema_violation") throw new HttpError(400, code, (error as Error).message);
  if (!isRefusal(code)) throw error;
  const message = (error as Error).message;
  await auditAdmissionRefusal(
    {
      tenant_id: context.principal.tenant_id,
      reason: code,
      message,
      workflow_id: context.workflow_id,
      ...(context.execution_id ? { execution_id: context.execution_id } : {}),
      request_source: context.request_source,
      actor_id: context.principal.id ?? null,
      actor_type: actorType(context.principal),
      ...(context.extra ? { extra: context.extra } : {}),
    },
    context.db,
  );
  const raw = (error as { details?: unknown }).details;
  const details =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? {
          ...(raw as Record<string, unknown>),
          ...(context.execution_id ? { execution_id: context.execution_id } : {}),
        }
      : context.execution_id
        ? { execution_id: context.execution_id }
        : undefined;
  throw new HttpError(409, code, message, details ? { details } : {});
}
