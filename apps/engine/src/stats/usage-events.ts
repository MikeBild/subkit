// Privacy-safe usage-event writer shared by HTTP, Chat, Conversations, and MCP.
//
// The accepted input is intentionally closed and payload-free. Every string
// persisted by this module is either a bounded enum/classifier or a canonical
// route template. Actor/session identities are HMACed with a SubKit-local key
// before they cross the database boundary.

import { createHmac } from "node:crypto";

import { and, eq, lt } from "drizzle-orm";

import { getConfig } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import { usageEvents } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { now } from "../utils/clock.ts";

export const USAGE_SURFACES = ["http", "chat", "mcp", "conversations"] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];
export const TRAFFIC_CLASSES = ["organic", "synthetic", "internal"] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

const OUTCOMES = new Set([
  "success",
  "client_error",
  "server_error",
  "denied",
  "cancelled",
  "disconnected",
  "deduplicated",
  "not_found",
  "rate_limited",
  "capacity_rejected",
  "ignored",
  "unknown",
]);

const STREAM_OUTCOMES = new Set(["completed", "cancelled", "errored", "not_streamed"]);
const RESPONSE_MODES = new Set(["json", "sse", "sync", "async", "none"]);
const PLATFORMS = new Set(["google_chat", "slack", "teams", "sk_cli", "http", "stdio"]);
const TASK_PHASES = new Set([
  "none",
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "EVENT"]);
const CHAT_OPERATIONS = new Set([
  "event/mention",
  "event/slash_command",
  "event/interaction",
  "event/system",
  "event/deduplicated",
]);
const CONVERSATION_OPERATIONS = new Set(["chat/turn", "mcp/call", "mcp/turn", "mcp/task/cancel"]);
const MCP_OPERATIONS = new Set([
  ...JSON_RPC_METHODS_FOR_WRITER(),
  "notifications/stream",
  "session/close",
  "session/initialized",
  "session/closed",
  "session/evicted",
  "transport/other",
  "jsonrpc/batch",
  "jsonrpc/invalid",
  "jsonrpc/other",
  "tools/call:conversation",
  "tools/call:workflow",
  "tools/call:knowledge",
  "tools/call:connector",
  "tools/call:execution",
  "tools/call:other",
]);

function JSON_RPC_METHODS_FOR_WRITER(): string[] {
  return [
    "initialize",
    "ping",
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "resources/subscribe",
    "resources/unsubscribe",
    "prompts/list",
    "prompts/get",
    "completion/complete",
    "tasks/get",
    "tasks/result",
    "tasks/list",
    "tasks/cancel",
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
  ];
}

export interface UsageEventInput {
  tenantId: string;
  surface: UsageSurface;
  operation: string;
  method?: string | undefined;
  outcome: string;
  trafficClass?: TrafficClass | undefined;
  requestSource: string;
  actorId?: string | null | undefined;
  sessionId?: string | null | undefined;
  statusCode?: number | null | undefined;
  durationMs?: number | null | undefined;
  requestBytes?: number | null | undefined;
  responseBytes?: number | null | undefined;
  streamOutcome?: string | null | undefined;
  platform?: string | null | undefined;
  responseMode?: string | null | undefined;
  taskPhase?: string | null | undefined;
  itemCount?: number | null | undefined;
  activeSessions?: number | null | undefined;
}

interface UsageConfig {
  enabled: boolean;
  hmacSecret: string;
  retentionDays: number;
}

const lastRetentionSweepAtByTenant = new Map<string, number>();
let warnedMissingSecret = false;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;

function usageConfig(): UsageConfig {
  try {
    const usage = getConfig().observability.usage;
    return {
      enabled: usage.enabled,
      hmacSecret: usage.hmac_secret,
      retentionDays: usage.retention_days,
    };
  } catch {
    return { enabled: false, hmacSecret: "", retentionDays: 90 };
  }
}

function boundedInt(value: number | null | undefined, max = 2_147_483_647): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function safeToken(value: string | null | undefined, allowed: Set<string>, fallback: string) {
  return value && allowed.has(value) ? value : fallback;
}

function canonicalOperation(surface: UsageSurface, value: string): string {
  if (surface === "chat") return CHAT_OPERATIONS.has(value) ? value : "event/system";
  if (surface === "mcp") return MCP_OPERATIONS.has(value) ? value : "jsonrpc/other";
  if (surface === "conversations" && CONVERSATION_OPERATIONS.has(value)) return value;
  if (value === "unmatched") return value;
  if (!value.startsWith("/") || /[?#]/.test(value) || value.includes("://")) return "unmatched";
  const segments = value.split("/").filter(Boolean);
  const dynamic = segments.some(
    (segment) =>
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ||
      /^\d{4,}$/.test(segment) ||
      (segment.length > 40 && !/^\{[A-Za-z0-9_]+\}$/.test(segment)),
  );
  if (dynamic || !/^\/[A-Za-z0-9_./{}:-]+$/.test(value)) return "unmatched";
  return value.slice(0, 160);
}

/** A stable, product-local pseudonym. Never export the source identifier. */
export function usageHmac(secret: string, tenantId: string, kind: "actor" | "session", id: string) {
  return createHmac("sha256", secret)
    .update(`subkit-usage-v1\0${tenantId}\0${kind}\0${id}`)
    .digest("hex");
}

/**
 * Persist one event. The caller may await this in tests/jobs; latency-sensitive
 * request paths use `recordUsageEvent`, the no-throw fire-and-forget wrapper.
 */
export async function appendUsageEvent(db: Executor, input: UsageEventInput): Promise<boolean> {
  const cfg = usageConfig();
  if (!cfg.enabled) return false;
  if (cfg.hmacSecret.length < 32) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn({
        module: "stats.usage",
        action: "usage.disabled_missing_secret",
        msg: "usage telemetry is enabled but observability.usage.hmac_secret is shorter than 32 characters",
      });
    }
    return false;
  }

  await db.insert(usageEvents).values({
    tenant_id: input.tenantId,
    surface: input.surface,
    // Route/method classifiers are capped as a final cardinality and privacy
    // guard. Callers must pass canonical values, never request content.
    operation: canonicalOperation(input.surface, input.operation),
    method: input.method ? safeToken(input.method, METHODS, "OTHER") : null,
    outcome: safeToken(input.outcome, OUTCOMES, "unknown"),
    traffic_class: input.trafficClass ?? "organic",
    request_source: RequestSourceSchema.safeParse(input.requestSource).success
      ? input.requestSource
      : "api",
    actor_hmac: input.actorId
      ? usageHmac(cfg.hmacSecret, input.tenantId, "actor", input.actorId)
      : null,
    session_hmac: input.sessionId
      ? usageHmac(cfg.hmacSecret, input.tenantId, "session", input.sessionId)
      : null,
    status_code: boundedInt(input.statusCode, 999),
    duration_ms: boundedInt(input.durationMs),
    request_bytes: boundedInt(input.requestBytes),
    response_bytes: boundedInt(input.responseBytes),
    stream_outcome: input.streamOutcome
      ? safeToken(input.streamOutcome, STREAM_OUTCOMES, "errored")
      : null,
    platform: input.platform ? safeToken(input.platform, PLATFORMS, "http") : null,
    response_mode: input.responseMode
      ? safeToken(input.responseMode, RESPONSE_MODES, "none")
      : null,
    task_phase: input.taskPhase ? safeToken(input.taskPhase, TASK_PHASES, "none") : null,
    item_count: boundedInt(input.itemCount),
    active_sessions: boundedInt(input.activeSessions),
  });

  const current = now();
  const lastRetentionSweepAt = lastRetentionSweepAtByTenant.get(input.tenantId) ?? 0;
  if (current - lastRetentionSweepAt >= RETENTION_SWEEP_INTERVAL_MS) {
    lastRetentionSweepAtByTenant.set(input.tenantId, current);
    const cutoff = new Date(current - cfg.retentionDays * 86_400_000);
    // Tenant predicate first, even for retention. This event's tenant pays
    // only for its own bounded cleanup and can never delete another tenant.
    await db
      .delete(usageEvents)
      .where(and(eq(usageEvents.tenant_id, input.tenantId), lt(usageEvents.created_at, cutoff)));
  }
  return true;
}

export function recordUsageEvent(db: Executor, input: UsageEventInput): void {
  void appendUsageEvent(db, input).catch((err: unknown) => {
    logger.debug({
      module: "stats.usage",
      action: "usage.write_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function trafficClassFromHeader(value: string | undefined): TrafficClass {
  return (TRAFFIC_CLASSES as readonly string[]).includes(value ?? "")
    ? (value as TrafficClass)
    : "organic";
}

/** Test seam for deterministic retention/config suites. */
export function resetUsageWriterForTests(): void {
  lastRetentionSweepAtByTenant.clear();
  warnedMissingSecret = false;
}
