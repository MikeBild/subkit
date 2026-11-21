import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/index.ts";

export interface RequestEventPayload {
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  request_source: string;
  tenant_id: string | null;
}

function isEnabled(): boolean {
  try {
    const cfg = getConfig().observability.analytics;
    return cfg.enabled && Boolean(cfg.endpoint);
  } catch {
    return false;
  }
}

export function emitRequestEvent(payload: RequestEventPayload): void {
  if (!isEnabled()) return;

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
