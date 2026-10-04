import type { ProbeErrorCode } from "./index.ts";

export function classifyGraphqlProbe(
  status: number,
  errorMessages: string[] | null,
): ProbeErrorCode {
  if (status === 401 || status === 403) return "credential_invalid";

  if (status === 404) return "remote_resource_not_found";

  if (status >= 200 && status < 300 && errorMessages !== null && errorMessages.length > 0) {
    const AUTH_TOKENS = [
      "unauthenticated",
      "unauthorized",
      "not authorized",
      "not authenticated",
      "access denied",
      "permission denied",
      "authentication required",
      "authentication failed",
      "invalid token",
      "token expired",
      "forbidden",
    ];
    const lower = errorMessages.map((m) => m.toLowerCase());
    if (lower.some((m) => AUTH_TOKENS.some((tok) => m.includes(tok)))) {
      return "credential_invalid";
    }
  }

  return "unknown_upstream_error";
}

export function classifyPgProbeError(err: unknown): ProbeErrorCode {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === "28P01" || code === "28000") return "credential_invalid";
  if (code === "3D000") return "remote_resource_not_found";
  return "unknown_upstream_error";
}

export function classifyS3ProbeError(err: unknown): ProbeErrorCode {
  const e = err as
    | { statusCode?: number; code?: string; name?: string; error_code?: string }
    | null
    | undefined;

  if (e?.name === "S3CredentialError") {
    return e.error_code === "credential_missing" ? "credential_missing" : "credential_invalid";
  }

  if (typeof e?.statusCode === "number") {
    if (e.statusCode === 401 || e.statusCode === 403) return "credential_invalid";
    if (e.statusCode === 404) return "remote_resource_not_found";
    return "unknown_upstream_error";
  }

  if (typeof e?.code === "string") {
    if (
      e.code === "InvalidAccessKeyId" ||
      e.code === "SignatureDoesNotMatch" ||
      e.code === "AccessDenied"
    ) {
      return "credential_invalid";
    }
    if (e.code === "NoSuchBucket") return "remote_resource_not_found";
  }

  return "unknown_upstream_error";
}
