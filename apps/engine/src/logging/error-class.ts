import { classifyPgProbeError } from "../connectors/drivers/probe-classify.ts";
import { isTransientDbError } from "../db/transient.ts";
import { HttpError } from "../http/errors.ts";
import { LlmError } from "../llm/errors.ts";
import { classifyProviderError } from "../llm/provider-errors.ts";
import { DomainRefusal } from "./domain-refusal.ts";

export type ErrorClass =
  | "transient"
  | "upstream_auth"
  | "upstream_tls"
  | "upstream_4xx"
  | "upstream_5xx"
  | "timeout"
  | "validation"
  | "resource"
  | "logic"
  | "refusal"
  | "unknown";

export function classifyError(err: unknown): ErrorClass {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    const cls = classifyDirect(cur);
    if (cls !== "unknown") return cls;
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return "unknown";
}

function classifyDirect(err: unknown): ErrorClass {
  if (err === null || err === undefined) return "unknown";

  if (err instanceof DomainRefusal) return "refusal";

  if (isTransientDbError(err)) return "transient";

  const netClass = classifyNetworkError(err);
  if (netClass) return netClass;

  const pgClass = classifyPgFromSqlstate(err);
  if (pgClass) return pgClass;

  if (err instanceof HttpError) {
    return mapHttpStatus(err.status);
  }

  if (err instanceof LlmError || looksLikeProviderError(err)) {
    const providerClass = mapProviderError(err);
    if (providerClass) return providerClass;
  }

  if (looksLikeValidationError(err)) return "validation";

  return "unknown";
}

const NETWORK_TIMEOUT_NAMES = new Set<string>(["TimeoutError", "AbortError"]);

const NETWORK_TIMEOUT_CODES = new Set<string>([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_ABORT",
]);

const NETWORK_CONNECTIVITY_CODES = new Set<string>([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UnknownHostName",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
]);

const TLS_CERT_CODES = new Set<string>([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "INVALID_CA",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "UND_ERR_PRX_TLS",
]);

function classifyNetworkError(err: unknown): ErrorClass | null {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (typeof name === "string" && NETWORK_TIMEOUT_NAMES.has(name)) return "timeout";

  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (NETWORK_TIMEOUT_CODES.has(code)) return "timeout";
    if (TLS_CERT_CODES.has(code)) return "upstream_tls";
    if (NETWORK_CONNECTIVITY_CODES.has(code)) return "transient";
  }
  return null;
}

function classifyPgFromSqlstate(err: unknown): ErrorClass | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return null;

  const probe = classifyPgProbeError(err);
  if (probe === "credential_invalid") return "upstream_auth";
  if (probe === "remote_resource_not_found") return "resource";

  if (code === "40001" || code === "40P01") return "transient";
  if (code === "57014") return "timeout";
  if (code === "42501") return "upstream_auth";

  switch (code.slice(0, 2)) {
    case "08":
    case "40":
      return "transient";
    case "28":
      return "upstream_auth";
    case "53":
    case "54":
    case "3D":
      return "resource";
    case "22":
      return "validation";
    default:
      return "logic";
  }
}

function looksLikeProviderError(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown } | null | undefined;
  return typeof e?.statusCode === "number" || typeof e?.status === "number";
}

function mapProviderError(err: unknown): ErrorClass | null {
  const kind = classifyProviderError(err);
  switch (kind) {
    case "rate_limit":
    case "overloaded":
      return "upstream_5xx";
    case "quota_exhausted":
      return "upstream_auth";
    case "timeout":
      return "timeout";
    case "context_length_exceeded":
      return "validation";
    case "network_5xx":
      return "upstream_5xx";
    default:
      return null;
  }
}

function mapHttpStatus(status: number): ErrorClass {
  if (status === 408 || status === 504) return "timeout";
  if (status === 401 || status === 403) return "upstream_auth";
  if (status >= 400 && status < 500) return "upstream_4xx";
  if (status >= 500) return "upstream_5xx";
  return "unknown";
}

function looksLikeValidationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name !== "ZodError") return false;
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues);
}
