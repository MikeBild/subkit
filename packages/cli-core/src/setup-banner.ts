const REQUEST_TIMEOUT_MS = 5_000;

export type SetupOverallStatus = "ok" | "warn" | "blocked";

export interface SetupStatusSnapshot {
  overall_status: SetupOverallStatus;
  warning_count: number;
  error_count: number;
}

export interface FetchSetupStatusOptions {
  fetch?: typeof globalThis.fetch;
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
