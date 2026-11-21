export const ERROR_CAUSES = [
  "auth_failed",
  "placeholder_unresolved",
  "schema_mismatch",
  "timeout",
  "aborted",
  "connector_missing",
  "budget_exhausted",
  "connector_unavailable",
  "refused_before_start",
  "authority_mismatch",
  "payload_invalid",
  "driver_error",
  "preview_unsupported",
  "unknown",
  "incomplete_read",
  "rate_limited",
] as const;

export type ErrorCause = (typeof ERROR_CAUSES)[number];

export const CLIENT_ERROR_CAUSES = [...ERROR_CAUSES, "version_unsupported"] as const;

export type ClientErrorCause = (typeof CLIENT_ERROR_CAUSES)[number];

export const REPAIR_REMEDIES = ["patch", "prepare", "declare", "reconnect", "author"] as const;

export type RepairRemedy = (typeof REPAIR_REMEDIES)[number];

export const REMEDIES = [
  ...REPAIR_REMEDIES,
  "grant",
  "sign_in",
  "retry",
  "wait",
  "raise_spend_limit",
  "provider_console",
] as const;

export type Remedy = (typeof REMEDIES)[number];

export const SPEND_LIMIT_REACHED = "llm_spend_limit_reached";
export const PROVIDER_QUOTA_EXHAUSTED = "llm_provider_quota_exhausted";
export const PROVIDER_LIMITED = "llm_provider_limited";
export const REGEX_UNSAFE = "regex_unsafe";

export interface ErrorClass {
  cause: ErrorCause;
  remedy: Remedy | null;
}

const entry = (cause: ErrorCause, remedy: Remedy | null): ErrorClass => ({ cause, remedy });

export const ERROR_CODES = {
  [SPEND_LIMIT_REACHED]: entry("budget_exhausted", "raise_spend_limit"),
  [PROVIDER_QUOTA_EXHAUSTED]: entry("budget_exhausted", "provider_console"),
  [PROVIDER_LIMITED]: entry("rate_limited", "wait"),
  llm_budget_exceeded: entry("budget_exhausted", "patch"),
  [REGEX_UNSAFE]: entry("payload_invalid", "patch"),
  connector_not_found: entry("connector_missing", "author"),
  connector_disabled: entry("connector_unavailable", "reconnect"),
  prepared_credential_unavailable: entry("connector_unavailable", "reconnect"),
  orphaned_preparation: entry("refused_before_start", "prepare"),
  outside_boundary: entry("authority_mismatch", "grant"),
  folder_changed: entry("authority_mismatch", "grant"),
  outside_allowance: entry("connector_unavailable", "grant"),
  origin_not_allowed: entry("connector_unavailable", "grant"),
  private_address: entry("connector_unavailable", null),
  permission_missing: entry("connector_unavailable", "grant"),
  trash_unavailable: entry("connector_unavailable", null),
  app_not_open: entry("connector_unavailable", "retry"),
  missing_graphql: entry("driver_error", "author"),
  unknown_step_kind: entry("driver_error", "author"),
  data_selector_error: entry("schema_mismatch", "patch"),
  graphql_pagination_incomplete: entry("incomplete_read", "patch"),
  upstream_rate_limited: entry("rate_limited", "wait"),
  http_429: entry("rate_limited", "wait"),
  graphql_throttle: entry("rate_limited", "wait"),
  placeholder_unresolved: entry("placeholder_unresolved", "patch"),
} as const satisfies Record<string, ErrorClass>;

export type ErrorCode = keyof typeof ERROR_CODES;

const PREFIX_CLASSES: ReadonlyArray<readonly [string, ErrorClass]> = [
  ["execution_authority_", entry("authority_mismatch", "grant")],
  ["pagination_", entry("incomplete_read", "patch")],
];

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}

export function classifyErrorCode(code: string): ErrorClass | null {
  if (isErrorCode(code)) return ERROR_CODES[code];
  for (const [prefix, cls] of PREFIX_CLASSES) {
    if (code.startsWith(prefix)) return cls;
  }
  return null;
}
