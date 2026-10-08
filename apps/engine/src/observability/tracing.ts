import { OpenTelemetry } from "@ai-sdk/otel";
import { trace } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";

export function langfuseEnrich(options: {
  runtimeContext: Record<string, unknown> | undefined;
}): Record<string, string> | undefined {
  const rc = options.runtimeContext;
  if (!rc) return undefined;
  const attrs: Record<string, string> = {};
  if (rc.conversation_id) attrs["langfuse.session.id"] = String(rc.conversation_id);
  if (rc.tenant_id) attrs["langfuse.trace.metadata.tenant_id"] = String(rc.tenant_id);
  if (rc.provider) attrs["langfuse.trace.metadata.provider"] = String(rc.provider);
  if (rc.model) attrs["langfuse.trace.metadata.model"] = String(rc.model);
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

export function toolSpanAttributes(p: {
  rule?: string;
  mode?: string;
  duration_ms?: number;
}): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};
  if (p.rule !== undefined) attrs["tool_policy.rule"] = p.rule;
  if (p.mode !== undefined) attrs["tool_policy.mode"] = p.mode;
  if (p.duration_ms !== undefined && Number.isFinite(p.duration_ms)) {
    attrs["tool.duration_ms"] = Math.round(p.duration_ms);
  }
  return attrs;
}

export function enrichActiveSpan(attrs: Record<string, string | number>): void {
  if (Object.keys(attrs).length === 0) return;
  try {
    trace.getActiveSpan()?.setAttributes(attrs);
  } catch (err) {
    logger.debug({
      module: "observability",
      action: "tracing.enrich_failed",
      msg: "active span attribute write threw — ignoring",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let telemetryIntegrationRegistered = false;
function ensureTelemetryIntegration(): void {
  if (telemetryIntegrationRegistered) return;
  registerTelemetry(
    new OpenTelemetry({ enrichSpan: langfuseEnrich, usage: true, providerMetadata: true }),
  );
  telemetryIntegrationRegistered = true;
}

interface TracingState {
  started: boolean;
  active: boolean;
  shutdown?: () => Promise<void>;
}

const state: TracingState = { started: false, active: false };

export async function startTracing(): Promise<() => Promise<void>> {
  if (state.started) {
    return state.shutdown ?? (async () => {});
  }
  state.started = true;

  const cfg = getConfig().observability;
  const otlpEndpoint = cfg.otlp.endpoint || undefined;
  const langfuseKey = cfg.langfuse.secret_key || undefined;
  if (!otlpEndpoint && !langfuseKey) {
    logger.info({
      module: "observability",
      action: "tracing.disabled",
      msg: "no OTel exporter configured — skipping tracer bootstrap",
    });
    state.active = false;
    const noop = async () => {};
    state.shutdown = noop;
    return noop;
  }

  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ]);

  const exporters: SpanExporter[] = [];
  if (otlpEndpoint) {
    exporters.push(new OTLPTraceExporter({ url: otlpEndpoint }));
  }
  if (langfuseKey) {
    const publicKey = cfg.langfuse.public_key || undefined;
    if (!publicKey) {
      logger.warn({
        module: "observability",
        action: "tracing.langfuse_public_key_missing",
        msg: "observability.langfuse.secret_key set without public_key — Langfuse OTLP needs both; skipping Langfuse exporter",
      });
    } else {
      const host = cfg.langfuse.host || "https://cloud.langfuse.com";
      const auth = Buffer.from(`${publicKey}:${langfuseKey}`).toString("base64");
      exporters.push(
        new OTLPTraceExporter({
          url: `${host.replace(/\/$/, "")}/api/public/otel/v1/traces`,
          headers: {
            Authorization: `Basic ${auth}`,
            "x-langfuse-ingestion-version": "4",
          },
        }),
      );
    }
  }

  const primary = exporters[0];
  if (!primary) {
    logger.info({
      module: "observability",
      action: "tracing.disabled",
      msg: "no usable OTel exporter after config resolution — skipping tracer bootstrap",
    });
    state.active = false;
    const noop = async () => {};
    state.shutdown = noop;
    return noop;
  }

  const sdk = new NodeSDK({
    serviceName: cfg.otlp.service_name || "subkit-engine",
    traceExporter: primary,
  });

  try {
    sdk.start();
    ensureTelemetryIntegration();
    state.active = true;
    logger.info({
      module: "observability",
      action: "tracing.started",
      msg: "OpenTelemetry tracer started",
      exporters: {
        otlp: Boolean(otlpEndpoint),
        langfuse: Boolean(langfuseKey),
      },
    });
  } catch (err) {
    logger.warn({
      module: "observability",
      action: "tracing.start_failed",
      msg: "OpenTelemetry tracer failed to start — continuing without tracing",
      error: err instanceof Error ? err.message : String(err),
    });
    state.active = false;
    const noop = async () => {};
    state.shutdown = noop;
    return noop;
  }

  const shutdown = async (): Promise<void> => {
    try {
      await sdk.shutdown();
    } catch (err) {
      logger.warn({
        module: "observability",
        action: "tracing.shutdown_failed",
        msg: "OpenTelemetry tracer shutdown failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  state.shutdown = shutdown;
  return shutdown;
}

export function isTracingStarted(): boolean {
  return state.started;
}

export function isTracingActive(): boolean {
  return state.active;
}

let _throwOnNextReconfigureForTests = false;
export function _failNextReconfigureForTests(): void {
  _throwOnNextReconfigureForTests = true;
}
export function _clearReconfigureFailureForTests(): void {
  _throwOnNextReconfigureForTests = false;
}

const RECONFIGURE_SHUTDOWN_TIMEOUT_MS = 5_000;

async function awaitWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const winner = await Promise.race([promise.then(() => "ok" as const), timeoutPromise]);
    if (winner === "timeout") onTimeout();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function reconfigureTracing(): Promise<void> {
  if (_throwOnNextReconfigureForTests) {
    _throwOnNextReconfigureForTests = false;
    throw new Error("forced reconfigure failure (test seam)");
  }
  const prev = state.shutdown;
  state.started = false;
  state.active = false;
  delete state.shutdown;
  if (prev) {
    await awaitWithTimeout(
      Promise.resolve()
        .then(() => prev())
        .catch((err) => {
          logger.warn({
            module: "observability",
            action: "tracing.reconfigure_shutdown_failed",
            msg: "tracing shutdown during reconfigure failed (continuing)",
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      RECONFIGURE_SHUTDOWN_TIMEOUT_MS,
      () => {
        logger.warn({
          module: "observability",
          action: "tracing.reconfigure_shutdown_timeout",
          msg: `tracing shutdown exceeded ${RECONFIGURE_SHUTDOWN_TIMEOUT_MS}ms; continuing with re-init`,
        });
      },
    );
  }
  await startTracing();
  logger.info({
    module: "observability",
    action: "tracing.reconfigured",
    msg: "OpenTelemetry tracer reconfigured from settings.changed",
  });
}
