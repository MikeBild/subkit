// Thin instrumentation helpers wrapping the metrics registry.
//
// Call sites import these instead of poking the registry directly so the
// surface stays small and the label vocabulary is enforced in one place.
// Every helper is a no-throw operation; failures are swallowed to keep
// observability code from ever taking down a request path.

import { logger } from "../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn({
      module: "observability",
      action: "metrics.write_failed",
      msg: "metric write threw — ignoring",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordExecutionTerminal(args: {
  tenant_id: string;
  workflow_id: string;
  status: string;
  request_source: string;
  duration_ms?: number | null;
}): void {
  safe(() => {
    const reg = getMetrics();
    reg.inc(METRIC_NAMES.EXECUTION_TOTAL, {
      tenant_id: args.tenant_id,
      workflow_id: args.workflow_id,
      status: args.status,
      request_source: args.request_source,
    });
    if (typeof args.duration_ms === "number" && Number.isFinite(args.duration_ms)) {
      reg.observe(METRIC_NAMES.EXECUTION_DURATION_MS, args.duration_ms, {
        tenant_id: args.tenant_id,
        workflow_id: args.workflow_id,
      });
    }
  });
}

export function recordRequestRetry(args: { connector_id?: string | null; reason: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.REQUEST_RETRY_TOTAL, {
      connector_id: args.connector_id ?? "",
      reason: args.reason,
    });
  });
}

export function recordWebhookDelivery(args: {
  subscription_id: string;
  status: "delivered" | "failed" | "circuit_open" | "dead_letter";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.WEBHOOK_DELIVERY_TOTAL, {
      subscription_id: args.subscription_id,
      status: args.status,
    });
  });
}

export function recordChatDelivery(args: {
  platform: string;
  status: "delivered" | "failed";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CHAT_DELIVERY_TOTAL, {
      platform: args.platform,
      status: args.status,
    });
  });
}

export function recordLlmTokens(args: {
  tenant_id: string;
  model: string;
  flow: string;
  prompt_tokens: number;
  completion_tokens: number;
}): void {
  safe(() => {
    const total = (args.prompt_tokens ?? 0) + (args.completion_tokens ?? 0);
    if (total <= 0) return;
    getMetrics().inc(
      METRIC_NAMES.LLM_TOKENS_TOTAL,
      {
        tenant_id: args.tenant_id,
        model: args.model,
        flow: args.flow,
      },
      total,
    );
  });
}

export function recordLlmQuotaExhausted(args: { tenant_id: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LLM_QUOTA_EXHAUSTED_TOTAL, {
      tenant_id: args.tenant_id,
    });
  });
}

export function setQueueDepth(queue: string, depth: number): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.QUEUE_DEPTH, depth, { queue });
  });
}

export function setQueueLag(queue: string, lag_ms: number): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.QUEUE_LAG_MS, lag_ms, { queue });
  });
}

export function setOutboxCursorLag(args: {
  listener_id: string;
  channel: string;
  lag: number;
}): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.OUTBOX_CURSOR_LAG, args.lag, {
      listener_id: args.listener_id,
      channel: args.channel,
    });
  });
}

export function setTunnelConnected(args: {
  tenant_id: string;
  target: string;
  connected: boolean;
}): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.TUNNEL_CONNECTED, args.connected ? 1 : 0, {
      tenant_id: args.tenant_id,
      target: args.target,
    });
  });
}

export function recordPatchCandidate(args: { classification: string; decision: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.PATCH_CANDIDATES_TOTAL, {
      classification: args.classification,
      decision: args.decision,
    });
  });
}
