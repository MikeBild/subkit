import { LOG_LEVEL_WEIGHT, type LogLevelName } from "@cli-core/log-levels.ts";
import { VERSION } from "@cli-core/version.ts";
import { withinAncestors } from "@shared/redaction.ts";
import pc from "picocolors";
import { readEnv } from "../env.ts";
import { logRing } from "../observability/log-ring.ts";
import { getContext } from "./context.ts";
import { classifyError, type ErrorClass } from "./error-class.ts";
import { redact } from "./redact.ts";

export type LogLevel = LogLevelName;

const LEVEL_WEIGHT = LOG_LEVEL_WEIGHT;

type RenderMode = "pretty" | "ndjson";

function defaultMode(): RenderMode {
  const tty = Boolean(process.stdout.isTTY);
  const env = (readEnv("NODE_ENV") ?? "development").toLowerCase();
  if (env === "production") return "ndjson";
  return tty ? "pretty" : "ndjson";
}

const SD_DAEMON_PREFIX: Record<LogLevelName, string> = {
  trace: "<7>",
  debug: "<7>",
  info: "<6>",
  warn: "<4>",
  error: "<3>",
  fatal: "<2>",
};

function defaultSdDaemonPrefix(): boolean {
  const flag = (readEnv("SUBKIT_LOG_SD_DAEMON") ?? "").toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return Boolean(readEnv("JOURNAL_STREAM"));
}

let MODE: RenderMode = defaultMode();
let THRESHOLD: number = LEVEL_WEIGHT.info;
let SD_DAEMON: boolean = defaultSdDaemonPrefix();

let NDJSON_SINK: "stdout" | "stderr" = "stdout";
export function routeLogsToStderr(): void {
  NDJSON_SINK = "stderr";
}

export function reconfigureLogger(opts: {
  level?: LogLevel;
  format?: "dev" | "pretty" | "prod" | "ndjson" | "json";
}): void {
  if (opts.level) {
    THRESHOLD = LEVEL_WEIGHT[opts.level] ?? LEVEL_WEIGHT.info;
  }
  if (opts.format) {
    const f = opts.format.toLowerCase();
    if (f === "pretty" || f === "dev") MODE = "pretty";
    else if (f === "ndjson" || f === "json" || f === "prod") MODE = "ndjson";
  }
}

export function _resetLoggerForTests(): void {
  MODE = defaultMode();
  THRESHOLD = LEVEL_WEIGHT.info;
  SD_DAEMON = defaultSdDaemonPrefix();
  MAX_FIELD_LEN = DEFAULT_MAX_FIELD_LEN;
  SERVICE_NAME = "subkit";
  DEPLOYMENT_ENVIRONMENT = readEnv("NODE_ENV") ?? "development";
}

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

const SENSITIVE_DATABASE_FIELD = /^(?:sql|query|params?|parameters?|bindings?)$/i;

export function isDatabaseQueryError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  return (
    /failed query:|\bparams:\s*/i.test(value.message) ||
    isSqlstate((value as Error & { code?: unknown }).code)
  );
}

function isSqlstate(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value);
}

function sanitizeDatabaseValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 32) return "[depth limit]";
  if (typeof value === "string")
    return /failed query:|\bparams:\s*/i.test(value) ? "database query failed" : value;
  if (value === null || typeof value !== "object") return value;
  return withinAncestors(value, seen, () => {
    const code = (value as { code?: unknown }).code;
    if (isSqlstate(code))
      return {
        error: "database query failed",
        ...(allowedSqlstate(code) ? { sqlstate: code } : {}),
      };
    if (Array.isArray(value))
      return value.map((entry) => sanitizeDatabaseValue(entry, seen, depth + 1));
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_DATABASE_FIELD.test(key))
        .map(([key, entry]) => [key, sanitizeDatabaseValue(entry, seen, depth + 1)]),
    );
  });
}

function databaseErrorCode(value: unknown): string | undefined {
  const seen = new Set<object>();
  for (let depth = 0; depth < 4 && value !== null && typeof value === "object"; depth++) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const source = value as { code?: unknown; cause?: unknown };
    if (isSqlstate(source.code)) return source.code;
    value = source.cause;
  }
  return undefined;
}

function allowedSqlstate(value: unknown): string | undefined {
  return isSqlstate(value) ? value : undefined;
}

function emitPretty(level: LogLevel, fields: LogFields): void {
  const ctx = getContext();
  const ts = formatTimestampPretty(new Date());
  const lvl = colorLevel(level, level.toUpperCase().padEnd(5));
  const ctxBits: string[] = [];
  if (ctx.trace_id) ctxBits.push(`trace=${ctx.trace_id}`);
  if (ctx.span_id) ctxBits.push(`span=${ctx.span_id}`);
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
  const redacted = rest;
  const restStr = Object.keys(redacted as object).length > 0 ? ` ${JSON.stringify(redacted)}` : "";

  const line = `${pc.dim(ts)} ${lvl} ${ctxStr}${moduleAction}${msg}${restStr}`;
  process.stderr.write(`${line}\n`);
}

const DEFAULT_MAX_FIELD_LEN = 2048;
let MAX_FIELD_LEN = DEFAULT_MAX_FIELD_LEN;
let SERVICE_NAME = "subkit";
let DEPLOYMENT_ENVIRONMENT = readEnv("NODE_ENV") ?? "development";

export function reconfigureObservability(opts: {
  field_truncation_chars?: number;
  service_name?: string;
  deployment_environment?: string;
}): void {
  const n = opts.field_truncation_chars;
  MAX_FIELD_LEN = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FIELD_LEN;
  if (opts.service_name?.trim()) SERVICE_NAME = opts.service_name.trim();
  if (opts.deployment_environment?.trim()) {
    DEPLOYMENT_ENVIRONMENT = opts.deployment_environment.trim();
  }
}

function truncateLongStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_FIELD_LEN) return value;
    const dropped = value.length - MAX_FIELD_LEN;
    return `${value.slice(0, MAX_FIELD_LEN)}…[truncated ${dropped} chars]`;
  }
  if (Array.isArray(value)) return value.map(truncateLongStrings);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateLongStrings(v);
    }
    return out;
  }
  return value;
}

function emitNdjson(level: LogLevel, fields: LogFields): void {
  const ctx = getContext();
  const redactedFields = fields;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ...ctx,
    ...redactedFields,
    "service.name": SERVICE_NAME,
    "service.version": VERSION,
    "deployment.environment.name": DEPLOYMENT_ENVIRONMENT,
  };
  const prefix = SD_DAEMON ? SD_DAEMON_PREFIX[level] : "";
  const sink = NDJSON_SINK === "stderr" ? process.stderr : process.stdout;
  sink.write(`${prefix}${JSON.stringify(record)}\n`);
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= THRESHOLD;
}

function recordToRing(level: LogLevel, fields: LogFields): void {
  const { module: m, action: a, msg, ...rest } = fields;
  const ctx = getContext() as Record<string, unknown>;
  const redactedRest = rest;
  const entry = {
    ts: Date.now(),
    level,
    fields: {
      ...ctx,
      ...redactedRest,
      "service.name": SERVICE_NAME,
      "service.version": VERSION,
      "deployment.environment.name": DEPLOYMENT_ENVIRONMENT,
    },
    ...(typeof m === "string" ? { module: m } : {}),
    ...(typeof a === "string" ? { action: a } : {}),
    ...(typeof msg === "string" ? { msg } : {}),
  };
  logRing.record(entry);
}

function emit(level: LogLevel, fields: LogFields): void {
  if (!shouldLog(level)) return;
  fields = truncateLongStrings(redact(sanitizeDatabaseValue(fields))) as LogFields;
  if (getContext().execution_privacy === "sensitive") {
    const allowed = new Set([
      "module",
      "action",
      "execution_id",
      "tenant_id",
      "workflow_id",
      "step_index",
      "kind",
      "status",
      "duration_ms",
      "retry_count",
    ]);
    fields = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
    fields.msg = "Sensitive execution.";
  }
  if (MODE === "pretty") emitPretty(level, fields);
  else emitNdjson(level, fields);
  if (fields.module === "audit") return;
  recordToRing(level, fields);
}

export function errorFields(err: unknown): {
  error: string;
  error_class: ErrorClass;
  cause?: string;
  stack?: string;
  sqlstate?: string;
} {
  const error_class = classifyError(err);
  if (!(err instanceof Error)) return { error: String(err), error_class };
  const databaseCode = databaseErrorCode(err);
  const queryError = isDatabaseQueryError(err) || databaseCode !== undefined;
  const out: {
    error: string;
    error_class: ErrorClass;
    cause?: string;
    stack?: string;
    sqlstate?: string;
  } = {
    error: queryError ? "database query failed" : (sanitizeDatabaseValue(err.message) as string),
    error_class,
  };
  const sqlstate = allowedSqlstate(databaseCode);
  if (sqlstate) out.sqlstate = sqlstate;
  if (err.cause instanceof Error) {
    out.cause =
      queryError || isDatabaseQueryError(err.cause)
        ? "database query failed"
        : (sanitizeDatabaseValue(err.cause.message) as string);
  } else if (err.cause !== undefined) out.cause = "database error cause omitted";
  if (err.stack && !queryError && !isDatabaseQueryError(err.cause))
    out.stack = sanitizeDatabaseValue(err.stack) as string;
  return out;
}

export const logger = {
  trace: (fields: LogFields) => emit("trace", fields),
  debug: (fields: LogFields) => emit("debug", fields),
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
  fatal: (fields: LogFields) => emit("fatal", fields),
} as const;

type Ctx = Record<string, unknown>;

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
      dequeued: (ctx: Ctx) => logger.info({ module: "queue", action: "job.dequeued", ...ctx }),
      completed: (ctx: Ctx) => logger.info({ module: "queue", action: "job.completed", ...ctx }),
      failed: (ctx: Ctx) => logger.error({ module: "queue", action: "job.failed", ...ctx }),
    },
    worker: {
      registered: (ctx: Ctx) =>
        logger.info({ module: "queue", action: "worker.registered", ...ctx }),
    },
  },
  execution: {
    started: (ctx: Ctx) => logger.info({ module: "execution", action: "started", ...ctx }),
    completed: (ctx: Ctx) => logger.info({ module: "execution", action: "completed", ...ctx }),
    step: {
      trace: (ctx: Ctx) => logger.debug({ module: "execution", action: "step", ...ctx }),
      completed: (ctx: Ctx) =>
        logger.debug({ module: "execution", action: "step.completed", ...ctx }),
      failed: (ctx: Ctx) => logger.warn({ module: "execution", action: "step.failed", ...ctx }),
      timeout: (ctx: Ctx) => logger.warn({ module: "execution", action: "step.timeout", ...ctx }),
    },
  },
  llm: {
    call: (ctx: Ctx) => logger.info({ module: "llm", action: "call", ...ctx }),
    error: (ctx: Ctx) => logger.error({ module: "llm", action: "error", ...ctx }),
    route: {
      resolved: (ctx: Ctx) => logger.debug({ module: "llm", action: "route.resolved", ...ctx }),
    },
    context: {
      assembled: (ctx: Ctx) => logger.debug({ module: "llm", action: "context.assembled", ...ctx }),
      trimmed: (ctx: Ctx) => logger.debug({ module: "llm", action: "context.trimmed", ...ctx }),
    },
  },
  webhooks: {
    inbound: {
      received: (ctx: Ctx) =>
        logger.info({ module: "webhooks.inbound", action: "received", ...ctx }),
      rejected: (ctx: Ctx) =>
        logger.warn({ module: "webhooks.inbound", action: "rejected", ...ctx }),
    },
    outbound: {
      delivered: (ctx: Ctx) =>
        logger.info({ module: "webhooks.outbound", action: "delivered", ...ctx }),
      failed: (ctx: Ctx) => logger.error({ module: "webhooks.outbound", action: "failed", ...ctx }),
      retried: (ctx: Ctx) =>
        logger.info({ module: "webhooks.outbound", action: "retried", ...ctx }),
      breaker: {
        open: (ctx: Ctx) =>
          logger.warn({ module: "webhooks.outbound", action: "breaker.open", ...ctx }),
      },
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
  conversation: {
    created: (ctx: Ctx) => logger.info({ module: "conversation", action: "created", ...ctx }),
    forked: (ctx: Ctx) => logger.info({ module: "conversation", action: "forked", ...ctx }),
    appended: (ctx: Ctx) => logger.debug({ module: "conversation", action: "appended", ...ctx }),
    completed: (ctx: Ctx) => logger.info({ module: "conversation", action: "completed", ...ctx }),
    compacted: (ctx: Ctx) => logger.info({ module: "conversation", action: "compacted", ...ctx }),
    approval: {
      requested: (ctx: Ctx) =>
        logger.info({ module: "conversation", action: "approval.requested", ...ctx }),
      approved: (ctx: Ctx) =>
        logger.info({ module: "conversation", action: "approval.approved", ...ctx }),
      rejected: (ctx: Ctx) =>
        logger.warn({ module: "conversation", action: "approval.rejected", ...ctx }),
    },
    tool: {
      called: (ctx: Ctx) => logger.debug({ module: "conversation", action: "tool.called", ...ctx }),
      succeeded: (ctx: Ctx) =>
        logger.debug({ module: "conversation", action: "tool.succeeded", ...ctx }),
      failed: (ctx: Ctx) => logger.warn({ module: "conversation", action: "tool.failed", ...ctx }),
    },
  },
  skill: {
    created: (ctx: Ctx) => logger.info({ module: "skill", action: "created", ...ctx }),
    updated: (ctx: Ctx) => logger.info({ module: "skill", action: "updated", ...ctx }),
    deleted: (ctx: Ctx) => logger.info({ module: "skill", action: "deleted", ...ctx }),
    lifecycle: (ctx: Ctx) => logger.info({ module: "skill", action: "lifecycle", ...ctx }),
    candidate: {
      proposed: (ctx: Ctx) =>
        logger.info({ module: "skill", action: "candidate.proposed", ...ctx }),
      contextRecorded: (ctx: Ctx) =>
        logger.info({ module: "skill", action: "candidate.context_recorded", ...ctx }),
      approved: (ctx: Ctx) =>
        logger.info({ module: "skill", action: "candidate.approved", ...ctx }),
      rejected: (ctx: Ctx) =>
        logger.warn({ module: "skill", action: "candidate.rejected", ...ctx }),
      dedup: (ctx: Ctx) => logger.debug({ module: "skill", action: "candidate.dedup", ...ctx }),
    },
  },
  knowledge: {
    ingested: (ctx: Ctx) => logger.info({ module: "knowledge", action: "ingested", ...ctx }),
    searched: (ctx: Ctx) => logger.info({ module: "knowledge", action: "searched", ...ctx }),
    analyzed: (ctx: Ctx) => logger.info({ module: "knowledge", action: "analyzed", ...ctx }),
    analyze_skipped: (ctx: Ctx) =>
      logger.warn({ module: "knowledge", action: "analyze_skipped", ...ctx }),
  },
  docs: {
    searched: (ctx: Ctx) => logger.info({ module: "docs", action: "searched", ...ctx }),
  },
  connectorTemplates: {
    suggested: (ctx: Ctx) =>
      logger.info({ module: "connector-templates", action: "suggested", ...ctx }),
  },
  selfHealing: {
    drift: {
      detected: (ctx: Ctx) =>
        logger.warn({ module: "self-healing", action: "drift.detected", ...ctx }),
    },
    patch: {
      proposed: (ctx: Ctx) =>
        logger.info({ module: "self-healing", action: "patch.proposed", ...ctx }),
      applied: (ctx: Ctx) =>
        logger.info({ module: "self-healing", action: "patch.applied", ...ctx }),
      notApplicable: (ctx: Ctx) =>
        logger.warn({ module: "self-healing", action: "patch.not_applicable", ...ctx }),
      closedInapplicable: (ctx: Ctx) =>
        logger.info({ module: "self-healing", action: "patch.closed_inapplicable", ...ctx }),
      sweepFailed: (ctx: Ctx) =>
        logger.error({ module: "self-healing", action: "patch.sweep_failed", ...ctx }),
      rejected: (ctx: Ctx) =>
        logger.warn({ module: "self-healing", action: "patch.rejected", ...ctx }),
      classified: (ctx: Ctx) =>
        logger.debug({ module: "self-healing", action: "patch.classified", ...ctx }),
    },
    policy: {
      evaluated: (ctx: Ctx) =>
        logger.debug({ module: "self-healing", action: "policy.evaluated", ...ctx }),
    },
    fixture: {
      passed: (ctx: Ctx) =>
        logger.info({ module: "self-healing", action: "fixture.passed", ...ctx }),
      failed: (ctx: Ctx) =>
        logger.warn({ module: "self-healing", action: "fixture.failed", ...ctx }),
    },
  },
  workflow: {
    committed: (ctx: Ctx) => logger.info({ module: "workflow", action: "committed", ...ctx }),
    restored: (ctx: Ctx) => logger.info({ module: "workflow", action: "restored", ...ctx }),
    validation: {
      failed: (ctx: Ctx) =>
        logger.warn({ module: "workflow", action: "validation.failed", ...ctx }),
    },
  },
  identity: {
    apiKey: {
      issued: (ctx: Ctx) => logger.info({ module: "identity", action: "api_key.issued", ...ctx }),
      rotated: (ctx: Ctx) => logger.info({ module: "identity", action: "api_key.rotated", ...ctx }),
      revoked: (ctx: Ctx) => logger.warn({ module: "identity", action: "api_key.revoked", ...ctx }),
    },
    portalToken: {
      issued: (ctx: Ctx) =>
        logger.info({ module: "identity", action: "portal_token.issued", ...ctx }),
      revoked: (ctx: Ctx) =>
        logger.warn({ module: "identity", action: "portal_token.revoked", ...ctx }),
    },
  },
  rbac: {
    checked: (ctx: Ctx) => logger.debug({ module: "rbac", action: "checked", ...ctx }),
    denied: (ctx: Ctx) => logger.warn({ module: "rbac", action: "denied", ...ctx }),
  },
  connector: {
    request: {
      planned: (ctx: Ctx) =>
        logger.debug({ module: "connector", action: "request.planned", ...ctx }),
    },
    probe: {
      completed: (ctx: Ctx) =>
        logger.debug({ module: "connector", action: "probe.completed", ...ctx }),
    },
    draft: {
      credential_rejected: (ctx: Ctx) =>
        logger.warn({ module: "connector", action: "draft.credential_rejected", ...ctx }),
      auth_param_in_config: (ctx: Ctx) =>
        logger.warn({ module: "connector", action: "draft.auth_param_in_config", ...ctx }),
    },
  },
  scheduler: {
    fired: (ctx: Ctx) => logger.info({ module: "scheduler", action: "job.fired", ...ctx }),
    reconciled: (ctx: Ctx) => logger.debug({ module: "scheduler", action: "reconciled", ...ctx }),
    lifecycle: (ctx: Ctx) => logger.info({ module: "scheduler", action: "lifecycle", ...ctx }),
  },
  boot: {
    phase: (ctx: Ctx) => logger.info({ module: "boot", action: "phase", ...ctx }),
    heartbeat: (ctx: Ctx) => logger.info({ module: "boot", action: "heartbeat", ...ctx }),
    heartbeatSlow: (ctx: Ctx) => logger.warn({ module: "boot", action: "heartbeat", ...ctx }),
    ready: (ctx: Ctx) => logger.info({ module: "boot", action: "ready", ...ctx }),
  },
  process: {
    memory: (ctx: Ctx) => logger.info({ module: "process", action: "memory.sample", ...ctx }),
    eventLoopLag: (ctx: Ctx) =>
      logger.warn({ module: "process", action: "event_loop.lag", ...ctx }),
  },
} as const;
