export type RunDispatchMode = "enqueue" | "inline" | "background";

export type RunErrorStage = "admission" | "execution";

export type RefusalClass =
  | "not_found"
  | "input"
  | "budget"
  | "caller_forbidden"
  | "authority_unready"
  | "boundary"
  | "bad_request"
  | "preparation_forbidden"
  | "permission_denied";

export interface RunRefusal {
  kind: "rejected";
  code: string;
  message: string;
  refusal: RefusalClass;
  reason?: string;
  details?: unknown;
  execution_id?: string;
  cause?: unknown;
}

export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export const CALLER_FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  "caller_required",
  "caller_kind_mismatch",
  "caller_product_mismatch",
  "caller_tenant_mismatch",
  "caller_saved_workflow_required",
  "sensitive_resume_forbidden",
]);

export const AUTHORITY_UNREADY_CODES: ReadonlySet<string> = new Set([
  "execution_authority_required",
  "execution_authority_unavailable",
  "execution_authority_changed",
  "workflow_version_not_active",
  "prepared_credential_unavailable",
]);

export const CALLER_BUDGET_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "turn_busy",
  "turn_limit",
  "invalid",
]);

const AUDITED_REFUSALS: ReadonlySet<RefusalClass> = new Set([
  "budget",
  "caller_forbidden",
  "authority_unready",
  "boundary",
]);

function isBoundaryCode(code: string): boolean {
  return (
    code.startsWith("execution_") ||
    code.startsWith("workflow_version_") ||
    code === "sensitive_execution_unsupported" ||
    code === "workflow_archived"
  );
}

export function classifyRunError(
  error: { code?: unknown; message?: unknown },
  stage: RunErrorStage,
): RefusalClass | null {
  if (typeof error.message === "string" && error.message.startsWith("workflow not found"))
    return "not_found";
  const code = typeof error.code === "string" ? error.code : null;
  if (code === null) return null;
  if (code === "input_schema_violation") return "input";
  if (stage === "admission" && CALLER_BUDGET_CODES.has(code)) return "budget";
  if (CALLER_FORBIDDEN_CODES.has(code)) return "caller_forbidden";
  if (AUTHORITY_UNREADY_CODES.has(code)) return "authority_unready";
  return isBoundaryCode(code) ? "boundary" : null;
}

export function refusalIsAudited(refusal: RefusalClass): boolean {
  return AUDITED_REFUSALS.has(refusal);
}

export function refusalFromError(
  error: unknown,
  stage: RunErrorStage,
  execution_id?: string,
): RunRefusal | null {
  if (typeof error !== "object" || error === null) return null;
  const facts = error as { code?: unknown; message?: unknown; details?: unknown };
  const refusal = classifyRunError(facts, stage);
  if (refusal === null) return null;
  return {
    kind: "rejected",
    code: refusal === "not_found" ? "workflow_not_found" : String(facts.code),
    message: String(facts.message ?? ""),
    refusal,
    ...(facts.details !== undefined ? { details: facts.details } : {}),
    ...(execution_id ? { execution_id } : {}),
    cause: error,
  };
}

function rejected(refusal: RefusalClass, code: string, message: string): RunRefusal {
  return { kind: "rejected", code, message, refusal };
}

export interface RunRequestFacts {
  idempotency_key: string | null;
  hold_writes: boolean | undefined;
  product_bearer: boolean;
  dispatch: RunDispatchMode;
  execution_authority_id: string | undefined;
}

export function precheckRunRequest(facts: RunRequestFacts): RunRefusal | null {
  const key = facts.idempotency_key;
  if (key !== null && (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH))
    return rejected(
      "bad_request",
      "bad_request",
      `idempotency_key must be 1..${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  if (facts.product_bearer && facts.hold_writes === true)
    return rejected(
      "preparation_forbidden",
      "product_preparation_forbidden",
      "A product caller runs only under a live execution authority; held preparations are for operators.",
    );
  if (facts.dispatch === "enqueue" && facts.execution_authority_id && key === null)
    return rejected(
      "bad_request",
      "bad_request",
      "An authorized async run requires an idempotency_key so queue retries reuse its reservation",
    );
  return null;
}

export function effectiveHoldWrites(
  product_bearer: boolean,
  hold_writes: boolean | undefined,
): boolean | undefined {
  return product_bearer ? false : hold_writes;
}

export interface AdmittedFacts {
  execution_authority_id: string | null;
  status: string;
  replayed: boolean;
}

export type ReplayedQueuedRun = "dispatch" | "return";

export function returnsReplay(admitted: AdmittedFacts, replayedQueued: ReplayedQueuedRun): boolean {
  if (!admitted.replayed) return false;
  return admitted.status !== "queued" || replayedQueued === "return";
}

export function requiresCurrentAuthority(mode: RunDispatchMode, admitted: AdmittedFacts): boolean {
  return (
    mode === "enqueue" && admitted.status === "queued" && admitted.execution_authority_id !== null
  );
}

export function finalizesOnEnqueueFailure(idempotency_key: string | null): boolean {
  return idempotency_key === null;
}

export function enqueueFailureMessage(parent_execution_id: string | undefined): string {
  return parent_execution_id
    ? "The rerun could not be enqueued."
    : "The execution could not be enqueued.";
}

export function resolveExecutionEnvironment(facts: {
  product_id: string | null;
  product_environment: "dev" | "prod" | null;
  requested: "dev" | "prod" | null;
}): "dev" | "prod" {
  if (facts.product_id) return facts.product_environment ?? "dev";
  return facts.requested ?? "dev";
}

export interface RbacDenialFacts {
  provider: string | undefined;
  allowlisted: boolean;
  reason: string | undefined;
}

export function rbacDenial(facts: RbacDenialFacts): { reason: string; message: string } {
  const allowlistViolation = facts.provider === "portal_token" || facts.allowlisted;
  return allowlistViolation
    ? { reason: "workflow_not_in_allowlist", message: "workflow_not_in_allowlist" }
    : {
        reason: facts.reason ?? "workflow_run_permission_denied",
        message: facts.reason ?? "permission_denied",
      };
}

export function refusalCause(refusal: RunRefusal): unknown {
  return refusal.cause ?? Object.assign(new Error(refusal.message), { code: refusal.code });
}
