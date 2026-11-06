import { actorType } from "../../audit/actor.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Executor } from "../../db/client.ts";
import { auditAdmissionRefusal } from "../../execution/admission-audit.ts";
import { isBearerProductPrincipal } from "../../execution/use-cases/run-workflow.ts";
import { type Rejection, reject } from "./index.ts";

const forbiddenCodes = new Set([
  "caller_required",
  "caller_kind_mismatch",
  "caller_product_mismatch",
  "caller_tenant_mismatch",
  "caller_saved_workflow_required",
  "sensitive_resume_forbidden",
]);

const productNotReadyCodes = new Set([
  "execution_authority_required",
  "execution_authority_unavailable",
  "execution_authority_changed",
  "workflow_version_not_active",
  "prepared_credential_unavailable",
]);

function productNotReady(principal: ResolvedPrincipal, code: string): boolean {
  return isBearerProductPrincipal(principal) && productNotReadyCodes.has(code);
}

function isRefusal(code: string | undefined): code is string {
  return (
    code !== undefined &&
    (code.startsWith("execution_") ||
      code.startsWith("workflow_version_") ||
      forbiddenCodes.has(code) ||
      code === "sensitive_execution_unsupported" ||
      code === "workflow_archived" ||
      code === "prepared_credential_unavailable")
  );
}

export interface AdmissionContext {
  readonly db: Executor;
  readonly principal: ResolvedPrincipal;
  readonly workflow_id?: string | null;
  readonly request_source: string;
  readonly execution_id?: string | null;
  readonly extra?: Record<string, unknown>;
}

export async function admissionRejection(
  error: unknown,
  context: AdmissionContext,
): Promise<Rejection> {
  if ((error as Error | undefined)?.message?.startsWith("workflow not found"))
    return reject.notFound("workflow");
  const code = (error as { code?: string }).code;
  if (code === "input_schema_violation") return reject.status(400, code, (error as Error).message);
  if (!isRefusal(code)) throw error;
  const message = (error as Error).message;
  await auditAdmissionRefusal(
    {
      tenant_id: context.principal.tenant_id,
      reason: code,
      message,
      ...(context.workflow_id ? { workflow_id: context.workflow_id } : {}),
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
  return reject.status(
    forbiddenCodes.has(code) || productNotReady(context.principal, code) ? 403 : 409,
    code,
    message,
    details,
  );
}
