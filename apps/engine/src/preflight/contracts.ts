// Bootstrap preflight — the shared vocabulary.
//
// The contract itself is prose, and the prose is the source of truth:
// `docs/BOOTSTRAP-PREFLIGHT.md` is a byte-identical copy of the text every
// product of the family carries, pinned by its sha256 in
// `tests/contract/bootstrap-preflight-konvention.test.ts`. This file is
// SubKit's own vocabulary for it — no code is shared with a sibling product,
// and nothing here reaches for one.
//
// What lives here and nowhere else:
//   * the refusal codes, as a closed union — a check may only refuse with a
//     code the contract names
//   * `refusalLine()`, the ONE line a refusal is allowed to print. It is
//     hand-rolled JSON rather than a `logger` call on purpose: the logger
//     decorates every record with module/action/msg/trace fields, and the
//     contract promises a single object with exactly three keys.
//
// The numbered checks map to `checks.ts`; the operator-facing mapping lives
// in `docs/admins/bootstrap-preflight.md`.

/** Every code a production refusal may carry. Ordered as the checks run. */
export const PREFLIGHT_REFUSAL_CODES = [
  // 1. MASTER_KEY
  "master_key_missing",
  "master_key_malformed",
  // 2. DATABASE_URL + schema version
  "database_url_missing",
  "database_unreachable",
  "schema_ahead",
  // 3. object store
  "object_store_missing",
  "object_store_unreachable",
  // 4. current settings revision
  "settings_unparsable",
  // 5. secret versions the settings bind to
  "secret_unreadable",
  // 6. identity provider configuration
  "identity_malformed",
] as const;

export type PreflightRefusalCode = (typeof PREFLIGHT_REFUSAL_CODES)[number];

/** The numbered check a result belongs to, named as the contract names it. */
export type PreflightCheckName =
  "master_key" | "schema" | "object_store" | "settings_revision" | "secret_bindings" | "identity";

export interface PreflightCheckResult {
  check: PreflightCheckName;
  ok: boolean;
  /** Present exactly when `ok` is false. */
  code?: PreflightRefusalCode;
  /** Human-readable, never secret material. */
  detail?: string;
}

/**
 * One observation a check made that is NOT a refusal — the contract
 * requires two of these to be logged rather than acted on:
 * `settings.retired_keys_dropped` and `identity.client_type public`.
 */
export interface PreflightNote {
  action: string;
  detail: string;
}

export interface PreflightOutcome {
  refused: boolean;
  /** In check order; stops at the first refusal. */
  results: PreflightCheckResult[];
  notes: PreflightNote[];
}

/** The first failing result, or null when the preflight passed. */
export function firstRefusal(outcome: PreflightOutcome): PreflightCheckResult | null {
  return outcome.results.find((r) => !r.ok) ?? null;
}

/**
 * The one structured line a refusal prints. Exactly three keys, in this
 * order, and no trailing newline — the caller owns the newline so a test
 * can assert the line without guessing at line endings.
 */
export function refusalLine(result: PreflightCheckResult): string {
  return JSON.stringify({
    event: "preflight.refused",
    code: result.code ?? "settings_unparsable",
    // Collapsed to a single line of whitespace. JSON.stringify already
    // escapes a newline, so this is not about validity — it is so the value
    // an operator READS in their terminal, and the value a `jq -r .detail`
    // prints, are both one line. Driver errors arrive multi-line
    // ("Failed query: SELECT 1\n  params: …") and a refusal that renders as
    // a paragraph is a refusal people stop reading.
    detail: (result.detail ?? "").replace(/\s+/g, " ").trim(),
  });
}

/** Exit codes, shared by `--preflight` and the automatic production run. */
export const PREFLIGHT_EXIT_OK = 0;
export const PREFLIGHT_EXIT_ERROR = 1;
export const PREFLIGHT_EXIT_REFUSED = 3;
