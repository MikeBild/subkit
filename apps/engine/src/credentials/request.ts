import { scrubString } from "@shared/redaction.ts";
import { type EgressGuardContext, getDriverFetch, guardedFetch } from "../connectors/index.ts";

const PROVIDER_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/i;
const PROVIDER_ERROR_DESCRIPTION_LIMIT = 200;
const RESPONSE_BODY_ERROR = "OAUTH_RESPONSE_BODY_ERROR";

export interface ProviderErrorDetail {
  readonly error?: string;
  readonly error_description?: string;
}

export class CredentialRequestError extends Error {
  readonly error?: string;
  readonly error_description?: string;

  constructor(
    readonly error_code:
      | "credential_egress_blocked"
      | "credential_request_failed"
      | "credential_response_rejected"
      | "credential_response_invalid",
    readonly status?: number,
    detail: ProviderErrorDetail = {},
  ) {
    super(`${error_code}${status === undefined ? "" : `: http_${status}`}`);
    if (detail.error !== undefined) this.error = detail.error;
    if (detail.error_description !== undefined) this.error_description = detail.error_description;
  }
}

function providerErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_ERROR_CODE.test(value) ? value : undefined;
}

function providerErrorDescription(
  value: unknown,
  secrets: readonly (string | null | undefined)[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  text = text.replace(/[^\x20-\x7e]+/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
  text = scrubString(text).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > PROVIDER_ERROR_DESCRIPTION_LIMIT
    ? `${text.slice(0, PROVIDER_ERROR_DESCRIPTION_LIMIT)}…`
    : text;
}

function isResponseBodyError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === RESPONSE_BODY_ERROR;
}

function responseStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  if (isResponseBodyError(error) && "status" in error && typeof error.status === "number")
    return error.status;
  const response = "response" in error ? error.response : null;
  return response instanceof Response ? response.status : undefined;
}

function providerErrorDetail(
  error: unknown,
  secrets: readonly (string | null | undefined)[],
): ProviderErrorDetail {
  if (!isResponseBodyError(error)) return {};
  const code = "error" in error ? providerErrorCode(error.error) : undefined;
  const description =
    "error_description" in error
      ? providerErrorDescription(error.error_description, secrets)
      : undefined;
  return {
    ...(code === undefined ? {} : { error: code }),
    ...(description === undefined ? {} : { error_description: description }),
  };
}

export async function credentialOperation<T>(
  operation: () => T | Promise<T>,
  secrets: readonly (string | null | undefined)[] = [],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
      if (cause instanceof CredentialRequestError) throw cause;
      if ("code" in cause && cause.code === "egress_blocked")
        throw new CredentialRequestError("credential_egress_blocked");
      cause = cause.cause;
    }
    throw new CredentialRequestError(
      "credential_request_failed",
      responseStatus(error),
      providerErrorDetail(error, secrets),
    );
  }
}

export function fetchCredentialRequest(
  context: EgressGuardContext,
  target: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  return credentialOperation(() => guardedFetch(context, getDriverFetch())(target, init));
}
