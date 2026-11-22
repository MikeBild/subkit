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

export interface AnalyticsTarget {
  endpoint: string;
  apiKey: string;
  project: string;
}

export type AnalyticsExporter = (request: Request) => Promise<Response>;

const EXPORT_TIMEOUT_MS = 3_000;

const httpExporter: AnalyticsExporter = (request) => fetch(request);

export function analyticsRequest(
  target: AnalyticsTarget,
  payload: RequestEventPayload,
  timestamp: string,
): Request | null {
  if (!target.endpoint) return null;
  const headers = new Headers({ "content-type": "application/json" });
  if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
  return new Request(target.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      event: "http_request",
      timestamp,
      project: target.project || undefined,
      properties: payload,
    }),
    signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
  });
}

function configuredTarget(): AnalyticsTarget | null {
  try {
    const raw = getConfig().observability.analytics;
    return { endpoint: raw.endpoint, apiKey: raw.api_key, project: raw.project };
  } catch {
    return null;
  }
}

async function sendEvent(payload: RequestEventPayload): Promise<void> {
  const target = configuredTarget();
  if (!target) return;
  try {
    const request = analyticsRequest(target, payload, new Date().toISOString());
    if (!request) return;
    const res = await httpExporter(request);
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
