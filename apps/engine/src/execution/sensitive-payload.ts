import { z } from "zod";
import { decryptSecret, encryptSecret } from "../crypto/index.ts";
import { DEVICE_STEP_ERROR_CODES, DEVICE_STEP_REMEDIES } from "../devices/core/step-output.ts";
import { classifyFailure, type PreviewClassification } from "./core/classify.ts";
import type { RequestMeta, SensitiveOutputField } from "./types.ts";

const SensitivePayloadSchema = z
  .object({
    $sensitive: z.literal(true),
    ciphertext: z.string(),
    iv: z.string(),
    auth_tag: z.string(),
  })
  .strict();

export function isSensitivePayload(value: unknown): boolean {
  return SensitivePayloadSchema.safeParse(value).success;
}

export function protectExecutionPayload(
  value: unknown,
  tenant: string,
  execution: string,
  slot: string,
) {
  const encrypted = encryptSecret(
    JSON.stringify(value ?? null),
    JSON.stringify([tenant, execution, slot]),
  );
  return {
    $sensitive: true as const,
    ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
    iv: Buffer.from(encrypted.iv).toString("base64"),
    auth_tag: Buffer.from(encrypted.auth_tag).toString("base64"),
  };
}

export function recoverExecutionPayload(
  value: unknown,
  tenant: string,
  execution: string,
  slot = "input",
): unknown {
  if (!isSensitivePayload(value)) return value;
  const payload = SensitivePayloadSchema.parse(value);
  return JSON.parse(
    decryptSecret(
      {
        ciphertext: Buffer.from(payload.ciphertext, "base64"),
        iv: Buffer.from(payload.iv, "base64"),
        auth_tag: Buffer.from(payload.auth_tag, "base64"),
      },
      JSON.stringify([tenant, execution, slot]),
    ),
  );
}

const safeFailureCodes = new Set([
  ...DEVICE_STEP_ERROR_CODES,
  "request_outside_declared_boundary",
  "execution_authority_changed",
  "execution_boundary_mismatch",
  "execution_authority_required",
  "execution_authority_unavailable",
  "execution_authentication_unavailable",
  "connector_disabled",
  "connector_not_found",
  "connector_environment_mismatch",
  "prepared_credential_unavailable",
  "llm_spend_limit_reached",
  "llm_budget_exceeded",
  "llm_spend_limit_reached",
  "authority_redirect_denied",
  "sensitive_resume_forbidden",
  "sensitive_execution_unsupported",
  "graphql_pagination_incomplete",
  "graphql_pagination_not_read_only",
  "pagination_limit_reached",
  "pagination_link_foreign",
  "pagination_link_unsupported",
  "pagination_link_loop",
  "pagination_short_page",
  "pagination_truncated",
  "upstream_rate_limited",
  "graphql_endpoint_invalid",
  "graphql_path_required",
  "data_selector_error",
  "input_schema_violation",
  "invalid",
  "caller_required",
  "caller_saved_workflow_required",
  "skipped_dependency_held",
  "skipped",
  "caller_tenant_mismatch",
  "caller_product_mismatch",
  "caller_kind_mismatch",
  "aborted",
  "timed_out",
  "engine_stopped_during_write",
  "mcp_timeout_during_write",
  "sandbox_memory",
  "sandbox_interrupt",
  "sandbox_timeout",
  "sandbox_syntax",
  "sandbox_runtime",
  "sandbox_marshal",
  "sandbox_stdlib_init",
  "sandbox_input_body",
  "sandbox_input_event_type",
  "sandbox_input_event_id",
  "sandbox_input_attributes",
  "sandbox_input_purpose",
  "sandbox_input_delivery_request",
  "sandbox_input_recipient",
  "sandbox_input_action_url",
]);

const SAFE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  skipped: "This step was skipped by the workflow's control flow or after an earlier step failed.",
  mcp_timeout_during_write:
    "A tool did not answer in time while it was sending a change. It may have reached the target; check there before you run it again.",
  engine_stopped_during_write:
    "The engine stopped while a step was sending a change. It may have reached the target; check there before you run it again.",
  graphql_pagination_incomplete:
    "GraphQL pages are incomplete. Check pageInfo, totalCount, cursor continuity and configured limits before retrying.",
  graphql_pagination_not_read_only:
    "Cursor pagination requires a read-only GraphQL query. Remove mutations from this step.",
  data_selector_error:
    "The step data selector failed. Check its expression against the connector response structure and validate the workflow before retrying.",
  pagination_limit_reached:
    "Pagination reached its configured page, item or size limit before the endpoint ended. Raise the limit or narrow the request.",
  pagination_link_foreign:
    "The next-page link pointed to another host. Nothing was sent there; check the endpoint before retrying.",
  pagination_link_unsupported:
    "The next-page link changed the request beyond the declared paging parameters. Check link_params before retrying.",
  pagination_link_loop:
    "The next-page link repeated an earlier page. Check the endpoint's paging before retrying.",
  pagination_short_page:
    "The server returned fewer items than requested while more pages exist. Lower page_size to the vendor maximum.",
  upstream_rate_limited:
    "The vendor's rate limit does not reset before the step or workflow deadline. Retry after the limit resets.",
  graphql_endpoint_invalid:
    "The GraphQL address must be a fixed GraphQL endpoint path ending in /graphql on the connector's own host, for example /graphql.",
  graphql_path_required: "A GraphQL step on an HTTP connector needs a fixed path such as /graphql.",
  pagination_truncated:
    "Pagination stopped at its configured limit, so this step's result is incomplete.",
  skipped_dependency_held:
    "This step was skipped because an earlier write step was held in the test run.",
  caller_saved_workflow_required: "This caller can only run a saved workflow version, not a draft.",
  ...Object.fromEntries(
    Object.entries(DEVICE_STEP_REMEDIES).map(([code, remedy]) => [
      code,
      `${remedy.message} ${remedy.guidance}`,
    ]),
  ),
};

const SAFE_CLASS_MESSAGES: Readonly<Partial<Record<PreviewClassification, string>>> = {
  auth_failed:
    "The connected service rejected the sign-in. Reconnect the connector, then run again. Nothing was changed by this step.",
  authority_mismatch:
    "The approval no longer covers what this run would do. Review and renew the approval, then run again.",
  connector_missing:
    "A connector this run needs does not exist in this environment. Add it, then run again.",
  connector_unavailable:
    "A connector this run needs is disabled or has no usable credential. Reconnect or enable it, then run again.",
  budget_exhausted:
    "The token allowance is used up. Raise the limit or wait for the month to roll over.",
  rate_limited: "The service's rate limit stopped this run. Retry after the limit resets.",
  timeout: "A step took longer than its time limit. Retry, or raise the limit.",
  placeholder_unresolved:
    "A step referred to a value that was not available. Check the workflow's inputs and earlier steps.",
  schema_mismatch:
    "The service answered in an unexpected shape. Check the step's data selector against the response.",
  incomplete_read: "The run stopped before every page was read, so its result would be incomplete.",
  payload_invalid:
    "The message a step built is malformed and was not sent. Fix how the step builds it; the approval still fits.",
};

const PROTECTED_MESSAGE = "Sensitive execution failed.";

export interface SensitiveFailure {
  code: string;
  message: string;
  error_class?: PreviewClassification;
}

export function sensitiveRunError(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  return Object.assign(new Error("Sensitive execution could not be resumed or run."), {
    code:
      typeof code === "string" && safeFailureCodes.has(code) ? code : "sensitive_execution_failure",
  });
}

export function sensitiveFailure(code?: string, message?: string): SensitiveFailure {
  const safeCode = code && safeFailureCodes.has(code) ? code : "sensitive_execution_failure";
  if (!code || safeCode === code)
    return { code: safeCode, message: SAFE_FAILURE_MESSAGES[safeCode] ?? PROTECTED_MESSAGE };
  const error_class = classifyFailure({
    status: "failed",
    error: { code, message: message ?? "" },
  });
  const classMessage = SAFE_CLASS_MESSAGES[error_class];
  return classMessage
    ? { code: safeCode, message: classMessage, error_class }
    : { code: safeCode, message: PROTECTED_MESSAGE };
}

export function sensitiveRequestMeta(meta: RequestMeta | null | undefined): RequestMeta | null {
  const pagination = meta && "pagination" in meta ? meta.pagination : undefined;
  if (!pagination) return null;
  const { strategy, pages, items, duplicates_dropped, complete, truncated, limit, rereads } =
    pagination;
  return {
    driver: "sensitive",
    pagination: {
      strategy,
      pages,
      items,
      duplicates_dropped,
      complete,
      truncated,
      limit,
      ...(rereads !== undefined ? { rereads } : {}),
    },
  };
}

function sensitiveFieldOf(value: unknown): SensitiveOutputField {
  if (value === undefined) return { type: "missing" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return { type: kind };
  return { type: "object" };
}

export function sensitiveOutputShape(
  output: unknown,
  outputSchema: unknown,
): Record<string, SensitiveOutputField> {
  const properties =
    outputSchema && typeof outputSchema === "object" && !Array.isArray(outputSchema)
      ? (outputSchema as { properties?: unknown }).properties
      : undefined;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  const record =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.keys(properties).map((key) => [
      key,
      sensitiveFieldOf(Object.hasOwn(record, key) ? record[key] : undefined),
    ]),
  );
}

export async function authorizeSensitiveResume(
  db: import("../db/client.ts").Db,
  row: { tenant_id: string; caller_context: unknown },
  principal?: import("../auth/types.ts").ResolvedPrincipal | null,
  internal = false,
): Promise<void> {
  const { CallerContextSchema, callerFromPrincipal } = await import("./caller-context.ts");
  const { isDeepStrictEqual } = await import("node:util");
  const caller = row.caller_context ? CallerContextSchema.parse(row.caller_context) : null;
  if (
    !internal &&
    (!principal ||
      !caller ||
      !isDeepStrictEqual(
        caller,
        callerFromPrincipal(principal, row.tenant_id, caller.productId ?? undefined),
      ))
  ) {
    throw Object.assign(new Error("Sensitive resume requires the original authenticated caller."), {
      code: "sensitive_resume_forbidden",
    });
  }
  if (caller) {
    if (!z.string().uuid().safeParse(caller.principalId).success) {
      throw Object.assign(new Error("Sensitive resume requires an active internal principal."), {
        code: "sensitive_resume_forbidden",
      });
    }
    const { and, eq } = await import("drizzle-orm");
    const { users, systemAccounts } = await import("../db/schema/index.ts");
    const active =
      caller.principalKind === "user"
        ? (
            await db
              .select({ deleted_at: users.deleted_at, status: users.status })
              .from(users)
              .where(and(eq(users.tenant_id, row.tenant_id), eq(users.id, caller.principalId)))
              .limit(1)
          )[0]
        : (
            await db
              .select({ deleted_at: systemAccounts.deleted_at })
              .from(systemAccounts)
              .where(
                and(
                  eq(systemAccounts.tenant_id, row.tenant_id),
                  eq(systemAccounts.id, caller.principalId),
                ),
              )
              .limit(1)
          )[0];
    if (
      !active ||
      active.deleted_at !== null ||
      ("status" in active && active.status !== "active")
    ) {
      throw Object.assign(new Error("Sensitive resume caller is no longer active."), {
        code: "sensitive_resume_forbidden",
      });
    }
  }
}
