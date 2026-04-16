// Tiny structured logger — keeps the tunnel agent binary dependency free.
// Always writes NDJSON to stderr so humans can pipe to jq and the engine's
// Kubernetes sidecar can scrape the stream.

type Level = "debug" | "info" | "warn" | "error";

function shouldLog(level: Level): boolean {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[(raw as Level) ?? "info"] ?? order.info;
  return order[level] >= threshold;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    module: "tunnel-agent",
    msg,
    ...fields,
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
