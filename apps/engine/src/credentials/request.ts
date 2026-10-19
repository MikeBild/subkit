import { type EgressGuardContext, getDriverFetch, guardedFetch } from "../connectors/index.ts";

export class CredentialRequestError extends Error {
  constructor(
    readonly error_code:
      | "credential_egress_blocked"
      | "credential_request_failed"
      | "credential_response_rejected"
      | "credential_response_invalid",
    readonly status?: number,
  ) {
    super(`${error_code}${status === undefined ? "" : `: http_${status}`}`);
  }
}

export async function credentialOperation<T>(operation: () => T | Promise<T>): Promise<T> {
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
    const response = error instanceof Error && "response" in error ? error.response : null;
    throw new CredentialRequestError(
      "credential_request_failed",
      response instanceof Response ? response.status : undefined,
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
