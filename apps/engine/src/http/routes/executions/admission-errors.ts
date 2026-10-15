import type { Context } from "hono";
import { actorType } from "../../../audit/index.ts";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import type { Executor } from "../../../db/client.ts";
import { auditAdmissionRefusal } from "../../../execution/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";

const forbiddenCodes = new Set([
  "caller_required",
  "caller_kind_mismatch",
  "caller_product_mismatch",
  "caller_tenant_mismatch",
  "caller_saved_workflow_required",
  "sensitive_resume_forbidden",
]);

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

export async function admissionRefusal(
  error: unknown,
  context: {
    db: Executor;
    principal: ResolvedPrincipal;
    workflow_id?: string | null;
    request_source: string;
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
  throw new HttpError(
    forbiddenCodes.has(code) ? 403 : 409,
    code,
    message,
    details ? { details } : {},
  );
}

const callerBudgetRefusals = {
  rate_limited: { status: 429, error: "rate-limited" },
  turn_closed: { status: 409, error: "turn-closed" },
  turn_busy: { status: 409, error: "turn-busy" },
  turn_limit: { status: 429, error: "turn-limit" },
  invalid: { status: 400, error: "invalid" },
} as const;

type CallerBudgetRefusalCode = keyof typeof callerBudgetRefusals;

function isCallerBudgetRefusal(code: unknown): code is CallerBudgetRefusalCode {
  return typeof code === "string" && Object.hasOwn(callerBudgetRefusals, code);
}

export async function callerBudgetRefusal(
  c: Context,
  error: unknown,
  context: {
    db: Executor;
    principal: ResolvedPrincipal;
    workflow_id: string;
    request_source: string;
  },
): Promise<Response | null> {
  const code = (error as { code?: unknown }).code;
  if (!isCallerBudgetRefusal(code)) return null;
  const message = (error as Error).message;
  await auditAdmissionRefusal(
    {
      tenant_id: context.principal.tenant_id,
      reason: code,
      message,
      workflow_id: context.workflow_id,
      request_source: context.request_source,
      actor_id: context.principal.id ?? null,
      actor_type: actorType(context.principal),
    },
    context.db,
  );
  const details = (error as { details?: { usage?: Record<string, unknown> } }).details;
  const usage = details?.usage
    ? { usedToday: details.usage.usedToday, dailyLimit: details.usage.dailyLimit }
    : undefined;
  const refusal = callerBudgetRefusals[code];
  return c.json(
    { error: refusal.error, code, message, ...(usage ? { usage } : {}) },
    refusal.status,
  );
}
