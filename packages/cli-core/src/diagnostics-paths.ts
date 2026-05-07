// Shared HTTP path constants for the engine's diagnostics surface.
//
// Imported by both the engine route registration and the `sk`
// client so a path rename in either place breaks typecheck on the
// other (review W6 — the SSE stream is not modeled by the OpenAPI
// generator, so we need this string in one place).

export const DIAGNOSTICS_LOG_STREAM_PATH = "/v1/diagnostics/logs/stream" as const;

export const DIAGNOSTICS_LOG_TAIL_PATH = "/v1/diagnostics/logs" as const;

export const DIAGNOSTICS_DRIFT_PATH = "/v1/diagnostics/drift" as const;
