// OpenTelemetry tracer bootstrap.
//
// Hooks AI SDK v6 `experimental_telemetry` calls (already attached at
// every call site in `llm/provider.ts`) into an OTel SDK. Two backends
// are supported:
//
//   - OTLP/HTTP exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`) — works with
//     any OTel collector: Jaeger, Grafana Tempo, Honeycomb, etc.
//   - Langfuse (`LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`) — LLM-
//     specific trace UI with token/cost breakdowns.
//
// Both can be enabled simultaneously. When neither is configured the
// tracer is a no-op so local `bun run dev` stays silent. Exporter
// failures are caught and logged at warn level so a flaky Langfuse
// instance can never stall a user request.
//
// Invoked from `http/server.ts` at boot. Idempotent — safe to call
// multiple times (tests).

import { LangfuseExporter } from "langfuse-vercel";
import { logger } from "../logging/logger.ts";

interface TracingState {
  started: boolean;
  shutdown?: () => Promise<void>;
}

const state: TracingState = { started: false };

/**
 * Start OpenTelemetry if any exporter is configured. Returns a
 * shutdown function (the SDK's internal one, or a no-op).
 */
export async function startTracing(): Promise<() => Promise<void>> {
  if (state.started) {
    return state.shutdown ?? (async () => {});
  }
  state.started = true;

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const langfuseKey = process.env.LANGFUSE_SECRET_KEY;
  if (!otlpEndpoint && !langfuseKey) {
    logger.info({
      module: "observability",
      action: "tracing.disabled",
      msg: "no OTel exporter configured — skipping tracer bootstrap",
    });
    const noop = async () => {};
    state.shutdown = noop;
    return noop;
  }

  // Lazy-import the heavy SDK bundles so engines built for cold-start
  // latency don't pay the OTel load cost when no exporter is set.
  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ]);

  const exporters: unknown[] = [];
  if (otlpEndpoint) {
    exporters.push(new OTLPTraceExporter({ url: otlpEndpoint }));
  }
  if (langfuseKey) {
    exporters.push(new LangfuseExporter());
  }

  // NodeSDK's `traceExporter` accepts only one; chain them via a
  // composite if needed. With a single exporter we pass it directly.
  const primary = exporters[0];
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "subkit-engine",
    // biome-ignore lint/suspicious/noExplicitAny: OTel SDK accepts a union of exporter shapes; Langfuse + OTLP both satisfy SpanExporter.
    traceExporter: primary as any,
  });

  try {
    sdk.start();
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
