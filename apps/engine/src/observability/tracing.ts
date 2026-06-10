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
import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";

interface TracingState {
  started: boolean;
  /** True only when at least one exporter (OTLP / Langfuse) is configured
   *  and the SDK started — i.e. spans actually go somewhere. */
  active: boolean;
  shutdown?: () => Promise<void>;
}

const state: TracingState = { started: false, active: false };

/**
 * Start OpenTelemetry if any exporter is configured. Returns a
 * shutdown function (the SDK's internal one, or a no-op).
 */
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
    const lfOpts: { secretKey: string; publicKey?: string; baseUrl?: string } = {
      secretKey: langfuseKey,
    };
    if (cfg.langfuse.public_key) lfOpts.publicKey = cfg.langfuse.public_key;
    if (cfg.langfuse.host) lfOpts.baseUrl = cfg.langfuse.host;
    exporters.push(new LangfuseExporter(lfOpts));
  }

  // NodeSDK's `traceExporter` accepts only one; chain them via a
  // composite if needed. With a single exporter we pass it directly.
  const primary = exporters[0];
  const sdk = new NodeSDK({
    serviceName: cfg.otlp.service_name || "subkit-engine",
    // biome-ignore lint/suspicious/noExplicitAny: OTel SDK accepts a union of exporter shapes; Langfuse + OTLP both satisfy SpanExporter.
    traceExporter: primary as any,
  });

  try {
    sdk.start();
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

/**
 * True only when spans actually reach an exporter. The AI SDK's
 * `experimental_telemetry` EAGERLY stringifies the full prompt (every
 * message, system block, tool definition) and output into span
 * attributes on every call — per STEP for streaming — even when the
 * tracer is a noop. Callers gate `recordInputs`/`recordOutputs` on this
 * so a no-exporter deployment doesn't pay megabytes of serialization
 * garbage per turn for attributes nobody ever sees.
 */
export function isTracingActive(): boolean {
  return state.active;
}

/**
 * Hot-reload the OTel SDK after an `observability.*` config change.
 *
 * Shuts down the existing exporter pipeline (best-effort), clears the
 * started flag, and re-runs startTracing(). Called by setConfigKey()
 * when an `observability.langfuse.*` or `observability.otlp.*` leaf
 * is updated, so operators see `sk settings set
 * observability.langfuse.secret_key '"…"'` take effect on the next
 * span without a process restart.
 *
 * Safe to call when tracing was never started (e.g. operator flips an
 * exporter on for the first time after boot) — the start path itself
 * checks for the no-config short-circuit.
 */
/** Test-only seam: when set, the next call to `reconfigureTracing()`
 *  throws synchronously. Used by audit-parity tests to fence the
 *  `metadata.reconfigure_failed = true` contract on the audit row.
 *  Test sets it; reconfigureTracing reads-and-clears it; the throw
 *  exercises the loader's catch branch. Production callers never set
 *  this.
 *
 *  Defensive cleanup: tests should always invoke
 *  `_clearReconfigureFailureForTests()` in a finally block (or
 *  afterEach) so a thrown assertion doesn't leak the flag into the
 *  next test's reconfigure. */
let _throwOnNextReconfigureForTests = false;
export function _failNextReconfigureForTests(): void {
  _throwOnNextReconfigureForTests = true;
}
export function _clearReconfigureFailureForTests(): void {
  _throwOnNextReconfigureForTests = false;
}

/** Hard upper bound on the per-call shutdown wait. The OTel
 *  BatchSpanProcessor + Langfuse SDKs both expose internal forceFlush
 *  budgets, but those are exporter-side and don't bound the SDK's
 *  network-export retries. Without this race, a hung Langfuse host
 *  could pin reconfigureTracing() — and therefore setConfigKey()'s
 *  global write lock — for 30+ seconds, starving every other settings
 *  write on the engine. 5 s is well above any healthy shutdown and
 *  short enough that an unrelated /v1/settings PUT doesn't notice. */
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
      // Wrap the shutdown in a try-catch — exporter throws are not a
      // gate, just a degraded-warn (current behavior).
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
        // Timeout: log the bounded wait, then fall through to
        // startTracing() so the new config still takes effect. The
        // OTel SDK's prior shutdown is not awaited further — its
        // exporter retries continue in the background and the
        // process either drains them or exits.
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
