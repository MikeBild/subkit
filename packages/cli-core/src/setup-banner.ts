// Setup-validation banner helper — fail-open.
//
// Purpose: drive the one-line orange/red banner the `sk` REPL prints
// above the welcome panel when `GET /v1/diagnostics/setup` reports a
// non-`ok` overall status. The banner itself lives in the Ink host;
// this module only handles the network call and shape normalization
// so the same logic can be reused by any CLI surface (sk, headless,
// install wizards) without duplicating fetch + timeout + error code.
//
// Design: fail-open. A transient diagnostics outage MUST NOT block
// CLI startup, hide a real warning state, or surface a banner the
// operator can't act on. On any error (timeout, 5xx, parse failure,
// network) we return a synthetic "ok" result with zero counts. The
// host treats that as "no banner" without needing to know whether the
// engine refused or simply hasn't booted yet.
//
// Polling cadence: the spec calls for one fetch on CLI start. The
// caller is responsible for any later refresh (e.g. after a
// reconnect). This module does not own a timer.

const REQUEST_TIMEOUT_MS = 5_000;

export type SetupOverallStatus = "ok" | "warn" | "blocked";

export interface SetupStatusSnapshot {
  overall_status: SetupOverallStatus;
  warning_count: number;
  error_count: number;
}

export interface FetchSetupStatusOptions {
  /**
   * Optional fetch shim. Tests pass a stubbed `fetch` so we don't
   * touch the network. Falls back to `globalThis.fetch` at runtime.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Override the default 5s timeout. Mostly here for tests that want
   * to assert timeout behavior without waiting 5 seconds of real time.
   */
  timeoutMs?: number;
}

const FAIL_OPEN: SetupStatusSnapshot = {
  overall_status: "ok",
  warning_count: 0,
  error_count: 0,
};

interface RawSetupResponse {
  overall_status?: unknown;
  summary_counts?: {
    blockers?: unknown;
    warnings?: unknown;
  };
}

function normalizeStatus(value: unknown): SetupOverallStatus {
  if (value === "warn" || value === "blocked" || value === "ok") return value;
  return "ok";
}

function normalizeCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

/**
 * Fetch `GET /v1/diagnostics/setup` and reduce to the three fields the
 * CLI banner needs. Fails open — any transport / parse / timeout error
 * resolves to the synthetic "ok" snapshot so a transient diagnostics
 * outage doesn't block startup or render a misleading banner.
 *
 * @param engineUrl Engine base URL (e.g. `http://localhost:3000`).
 * @param apiKey Bearer token (API key, portal token, or session token).
 */
export async function fetchSetupStatus(
  engineUrl: string,
  apiKey: string,
  opts: FetchSetupStatusOptions = {},
): Promise<SetupStatusSnapshot> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return FAIL_OPEN;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const trimmedBase = engineUrl.replace(/\/$/, "");
  const url = `${trimmedBase}/v1/diagnostics/setup`;
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return FAIL_OPEN;
    const body = (await response.json()) as RawSetupResponse;
    if (!body || typeof body !== "object") return FAIL_OPEN;
    const overall = normalizeStatus(body.overall_status);
    const warnings = normalizeCount(body.summary_counts?.warnings);
    const blockers = normalizeCount(body.summary_counts?.blockers);
    return {
      overall_status: overall,
      warning_count: warnings,
      error_count: blockers,
    };
  } catch {
    return FAIL_OPEN;
  }
}
