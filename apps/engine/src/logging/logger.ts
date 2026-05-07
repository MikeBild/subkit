import pc from "picocolors";
import { logRing } from "../observability/log-ring.ts";
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

// Phase 1 boot defaults: read only NODE_ENV + TTY. LOG_LEVEL / LOG_FORMAT
// have moved into subkit.config.json (see apps/engine/src/config/schema.ts).
// `reconfigureLogger()` swaps these to the configured values right after
// `loadConfig()` resolves; until then the logger is the only safe surface
// for boot-time error reporting (no `console.*` anywhere).
function defaultMode(): RenderMode {
  const tty = Boolean(process.stdout.isTTY);
  const env = (process.env.NODE_ENV ?? "development").toLowerCase();
  if (env === "production") return "ndjson";
  return tty ? "pretty" : "ndjson";
}

let MODE: RenderMode = defaultMode();
let THRESHOLD: number = LEVEL_WEIGHT.info;

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

// Test-only — restore Phase 1 defaults between cases that call `reconfigureLogger`.
export function _resetLoggerForTests(): void {
  MODE = defaultMode();
  THRESHOLD = LEVEL_WEIGHT.info;
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

function recordToRing(level: LogLevel, fields: LogFields): void {
  // Mirror to the in-memory ring so /v1/diagnostics/logs and the SSE
  // tail can serve it. Strip module/action/msg for the bag; redact the
  // rest so sensitive headers don't leak into the diagnostics surface.
  const { module: m, action: a, msg, ...rest } = fields;
  const entry = {
    ts: Date.now(),
    level,
    fields: redact(rest) as Record<string, unknown>,
    ...(typeof m === "string" ? { module: m } : {}),
    ...(typeof a === "string" ? { action: a } : {}),
    ...(typeof msg === "string" ? { msg } : {}),
  };
  // Preserve trace/tenant/etc context so log tails can be filtered.
  const ctx = getContext();
  Object.assign(entry.fields, ctx);
  logRing.record(entry);
}

function emit(level: LogLevel, fields: LogFields): void {
  if (!shouldLog(level)) return;
  if (MODE === "pretty") emitPretty(level, fields);
  else emitNdjson(level, fields);
  recordToRing(level, fields);
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
      // Info (not debug) because operators already alert on dequeue cadence
      // in existing dashboards; downgrading to debug would silence them.
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
    // Module name is plural to match the `webhooks/` directory and the
    // existing raw callers that already emit `module: "webhooks.outbound"`
    // / `module: "webhooks.inbound"`.
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
      approved: (ctx: Ctx) =>
        logger.info({ module: "skill", action: "candidate.approved", ...ctx }),
      rejected: (ctx: Ctx) =>
        logger.warn({ module: "skill", action: "candidate.rejected", ...ctx }),
      // `promoted` deliberately omitted — candidate.approved already
      // carries the `promoted_skill_id`; a second event would be
      // redundant.
      dedup: (ctx: Ctx) => logger.debug({ module: "skill", action: "candidate.dedup", ...ctx }),
    },
  },
  knowledge: {
    ingested: (ctx: Ctx) => logger.info({ module: "knowledge", action: "ingested", ...ctx }),
    searched: (ctx: Ctx) => logger.debug({ module: "knowledge", action: "searched", ...ctx }),
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
    },
  },
  scheduler: {
    fired: (ctx: Ctx) => logger.info({ module: "scheduler", action: "job.fired", ...ctx }),
    reconciled: (ctx: Ctx) => logger.debug({ module: "scheduler", action: "reconciled", ...ctx }),
    lifecycle: (ctx: Ctx) => logger.info({ module: "scheduler", action: "lifecycle", ...ctx }),
  },
  tunnel: {
    auth: (ctx: Ctx) => logger.info({ module: "tunnel", action: "auth", ...ctx }),
    register: (ctx: Ctx) => logger.info({ module: "tunnel", action: "register", ...ctx }),
    forward: (ctx: Ctx) => logger.debug({ module: "tunnel", action: "forward", ...ctx }),
  },
} as const;
