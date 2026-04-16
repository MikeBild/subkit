import pc from "picocolors";
import { getContext } from "./context.ts";
import { redact } from "./redact.ts";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

type RenderMode = "pretty" | "ndjson";

function detectMode(): RenderMode {
  const raw = (process.env.LOG_FORMAT ?? "").toLowerCase();
  if (raw === "ndjson" || raw === "json" || raw === "prod") return "ndjson";
  if (raw === "pretty" || raw === "dev") return "pretty";
  const env = (process.env.NODE_ENV ?? "development").toLowerCase();
  return env === "production" ? "ndjson" : "pretty";
}

function detectThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVEL_WEIGHT[raw] ?? LEVEL_WEIGHT.info;
}

const MODE: RenderMode = detectMode();
const THRESHOLD: number = detectThreshold();

function formatTimestampPretty(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function colorLevel(level: LogLevel, text: string): string {
  switch (level) {
    case "trace":
      return pc.gray(text);
    case "debug":
      return pc.cyan(text);
    case "info":
      return pc.green(text);
    case "warn":
      return pc.yellow(text);
    case "error":
      return pc.red(text);
    case "fatal":
      return pc.bgRed(pc.white(text));
    default:
      return text;
  }
}

export type LogFields = {
  module?: string;
  action?: string;
  msg?: string;
  [key: string]: unknown;
};

function emitPretty(level: LogLevel, fields: LogFields): void {
  const ctx = getContext();
  const ts = formatTimestampPretty(new Date());
  const lvl = colorLevel(level, level.toUpperCase().padEnd(5));
  const ctxBits: string[] = [];
  if (ctx.trace_id) ctxBits.push(`trace=${ctx.trace_id}`);
  if (ctx.tenant_id) ctxBits.push(`tenant=${ctx.tenant_id}`);
  if (ctx.execution_id) ctxBits.push(`exec=${ctx.execution_id}`);
  if (ctx.workflow_id) ctxBits.push(`workflow=${ctx.workflow_id}`);
  if (ctx.request_source) ctxBits.push(`src=${ctx.request_source}`);
  if (ctx.actor_id) ctxBits.push(`actor=${ctx.actor_id}`);
  const ctxStr = ctxBits.length > 0 ? pc.dim(`[${ctxBits.join(" ")}] `) : "";

  const moduleAction =
    fields.module || fields.action
      ? `${pc.magenta(`${fields.module ?? "?"}.${fields.action ?? "?"}`)}: `
      : "";
  const msg = fields.msg ?? "";
  const { module: _m, action: _a, msg: _msg, ...rest } = fields;
  const redacted = redact(rest);
  const restStr = Object.keys(redacted as object).length > 0 ? ` ${JSON.stringify(redacted)}` : "";

  const line = `${pc.dim(ts)} ${lvl} ${ctxStr}${moduleAction}${msg}${restStr}`;
  // Dev mode mirrors to stderr for immediate terminal visibility.
  process.stderr.write(`${line}\n`);
}

function emitNdjson(level: LogLevel, fields: LogFields): void {
  const ctx = getContext();
  const redactedFields = redact(fields) as Record<string, unknown>;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ...ctx,
    ...redactedFields,
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= THRESHOLD;
}

function emit(level: LogLevel, fields: LogFields): void {
  if (!shouldLog(level)) return;
  if (MODE === "pretty") emitPretty(level, fields);
  else emitNdjson(level, fields);
}

/**
 * Core logger. Prefer the domain helpers (`log.http.request.started`, etc.)
 * below for common events so that `module` / `action` stay consistent.
 */
export const logger = {
  trace: (fields: LogFields) => emit("trace", fields),
  debug: (fields: LogFields) => emit("debug", fields),
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
  fatal: (fields: LogFields) => emit("fatal", fields),
} as const;

type Ctx = Record<string, unknown>;

/**
 * Namespaced helpers. Each helper sets `module` + `action` and forwards to
 * the core logger. Adding a new helper is a single line here.
 */
export const log = {
  ...logger,
  http: {
    request: {
      started: (ctx: Ctx) => logger.info({ module: "http", action: "request.started", ...ctx }),
      completed: (ctx: Ctx) => logger.info({ module: "http", action: "request.completed", ...ctx }),
      failed: (ctx: Ctx) => logger.error({ module: "http", action: "request.failed", ...ctx }),
    },
  },
  queue: {
    job: {
      dequeued: (ctx: Ctx) => logger.debug({ module: "queue", action: "job.dequeued", ...ctx }),
      completed: (ctx: Ctx) => logger.info({ module: "queue", action: "job.completed", ...ctx }),
      failed: (ctx: Ctx) => logger.error({ module: "queue", action: "job.failed", ...ctx }),
    },
  },
  execution: {
    started: (ctx: Ctx) => logger.info({ module: "execution", action: "started", ...ctx }),
    step: (ctx: Ctx) => logger.debug({ module: "execution", action: "step", ...ctx }),
    completed: (ctx: Ctx) => logger.info({ module: "execution", action: "completed", ...ctx }),
  },
  llm: {
    call: (ctx: Ctx) => logger.info({ module: "llm", action: "call", ...ctx }),
    error: (ctx: Ctx) => logger.error({ module: "llm", action: "error", ...ctx }),
  },
  webhook: {
    inbound: {
      received: (ctx: Ctx) =>
        logger.info({ module: "webhook", action: "inbound.received", ...ctx }),
    },
    outbound: {
      delivered: (ctx: Ctx) =>
        logger.info({ module: "webhook", action: "outbound.delivered", ...ctx }),
      failed: (ctx: Ctx) => logger.error({ module: "webhook", action: "outbound.failed", ...ctx }),
    },
  },
  chat: {
    inbound: {
      received: (ctx: Ctx) => logger.info({ module: "chat", action: "inbound.received", ...ctx }),
    },
    outbound: {
      delivered: (ctx: Ctx) =>
        logger.info({ module: "chat", action: "outbound.delivered", ...ctx }),
    },
  },
  auth: {
    resolved: (ctx: Ctx) => logger.info({ module: "auth", action: "resolved", ...ctx }),
    denied: (ctx: Ctx) => logger.warn({ module: "auth", action: "denied", ...ctx }),
  },
} as const;
