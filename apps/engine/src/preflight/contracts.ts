const PREFLIGHT_REFUSAL_CODES = [
  "master_key_missing",
  "master_key_malformed",
  "database_url_missing",
  "database_unreachable",
  "schema_ahead",
  "schema_behind",
  "object_store_missing",
  "object_store_unreachable",
  "filesystem_store_needs_local_mode",
  "settings_unparsable",
  "secret_unreadable",
  "identity_malformed",
] as const;

export type PreflightRefusalCode = (typeof PREFLIGHT_REFUSAL_CODES)[number];

export type PreflightCheckName =
  | "master_key"
  | "schema"
  | "object_store"
  | "settings_revision"
  | "secret_bindings"
  | "identity";

export interface PreflightCheckResult {
  check: PreflightCheckName;
  ok: boolean;
  code?: PreflightRefusalCode;
  detail?: string;
}

export interface PreflightNote {
  action: string;
  detail: string;
}

export interface PreflightOutcome {
  refused: boolean;
  results: PreflightCheckResult[];
  notes: PreflightNote[];
}

export function firstRefusal(outcome: PreflightOutcome): PreflightCheckResult | null {
  return outcome.results.find((r) => !r.ok) ?? null;
}

export function refusalLine(result: PreflightCheckResult): string {
  return JSON.stringify({
    event: "preflight.refused",
    code: result.code ?? "settings_unparsable",
    detail: (result.detail ?? "").replace(/\s+/g, " ").trim(),
  });
}

export const PREFLIGHT_EXIT_OK = 0;
export const PREFLIGHT_EXIT_REFUSED = 3;
