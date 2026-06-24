// Config-driven product analytics emitter.
//
// Disabled by default (`observability.analytics.enabled = false`). When off,
// every public function is a synchronous no-op — no SDK is loaded, no fetch
// is attempted, no async work is queued. When enabled, events are forwarded
// to the configured endpoint via a fire-and-forget POST; failures are logged
// at debug level and never propagate into the caller's path.
//
// The only emission point is `emitRequestEvent`, called from the existing
// `metricsMiddleware` `request.telemetry` seam (middleware.ts). There is no
// second hook path; adding one here is the wrong layer.
//
// Config fields (all under `observability.analytics`):
//   enabled  — boolean, default false. Total no-op when false.
//   endpoint — self-hostable ingest URL (empty = no-op even if enabled).
//   api_key  — bearer credential for the endpoint (secret, optional).
//   project  — project/workspace identifier surfaced per event.

import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";

export interface RequestEventPayload {
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  request_source: string;
  tenant_id: string | null;
}

/** Returns true only when analytics is fully configured and enabled.
 *  Called once per request in the hot path, so we keep it cheap. */
function isEnabled(): boolean {
  try {
    const cfg = getConfig().observability.analytics;
    return cfg.enabled && Boolean(cfg.endpoint);
  } catch {
    // Config loader not initialised (unit tests that don't boot the engine).
    return false;
  }
}

/**
 * Fire-and-forget emission of an HTTP-response event to the configured
 * analytics endpoint. When analytics is disabled or misconfigured this
 * is a synchronous no-op: no async work is created, no fetch is issued.
 *
 * Called from `metricsMiddleware` at the `request.telemetry` point —
 * the single existing per-response hook — so we reuse that seam rather
 * than adding a parallel one.
 */
export function emitRequestEvent(payload: RequestEventPayload): void {
  if (!isEnabled()) return;

  // Non-blocking: we deliberately do not await this. Telemetry must
  // never stall the response path.
  void sendEvent(payload);
}

async function sendEvent(payload: RequestEventPayload): Promise<void> {
  let cfg: { endpoint: string; api_key: string; project: string };
  try {
    const raw = getConfig().observability.analytics;
    cfg = { endpoint: raw.endpoint, api_key: raw.api_key, project: raw.project };
  } catch {
    return;
  }
  if (!cfg.endpoint) return;

  const body = JSON.stringify({
    event: "http_request",
    timestamp: new Date().toISOString(),
    project: cfg.project || undefined,
    properties: payload,
  });

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (cfg.api_key) {
      headers.authorization = `Bearer ${cfg.api_key}`;
    }
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers,
      body,
      // Bound the analytics call so a slow endpoint can't hold a keep-alive
      // connection open. AbortSignal.timeout is Node-native since v17.
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      logger.debug({
        module: "observability.analytics",
        action: "emit.failed",
        status: res.status,
      });
    }
  } catch (err) {
    logger.debug({
      module: "observability.analytics",
      action: "emit.error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
