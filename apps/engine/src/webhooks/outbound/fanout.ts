// Outbound fan-out.
//
// Listens on the outbox `event.emitted` channel. For each event:
//   1. load all active subscriptions for the tenant
//   2. filter down to subscriptions whose event_pattern matches the
//      event type (simple glob: `*`, `execution.*`, exact)
//   3. for each match, enqueue a single `webhook.deliver` job with
//      attempt_number = 1 and a fresh webhook-id / timestamp.
//
// The fan-out itself does NOT perform HTTP delivery — it only
// translates outbox events into delivery jobs. The delivery worker is
// where signing + retries + circuit breaking happen.

import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import type { ChatAdapterRegistry } from "../../chat/registry.ts";
import type { ChatPlatform } from "../../chat/types.ts";
import type { Db } from "../../db/client.ts";
import { events, subscriptions } from "../../db/schema/index.ts";
import type { RequestSource } from "../../execution/types.ts";
import { logger } from "../../logging/logger.ts";
import type { NotificationEvent, NotificationSeverity } from "../../notifications/matcher.ts";
import {
  type AdapterResolver,
  dispatchEvent as dispatchNotifications,
} from "../../notifications/service.ts";
import { matchEventPattern } from "../events/catalog.ts";
import { WEBHOOK_DELIVER_QUEUE, type WebhookDeliverJob } from "./delivery-worker.ts";

// RFC-4122 v5 UUID namespace for outbox-derived delivery ids (arbitrary,
// fixed). Deriving the delivery event_id from the stable outbox row id makes
// fanout retries idempotent: a re-run emits the same event_id.
const OUTBOX_EVENT_NS = "9f1c2e4a-6b3d-5c7e-8a9b-0c1d2e3f4a5b";

export function deterministicEventId(eventRowId: number): string {
  const nsHex = OUTBOX_EVENT_NS.replace(/-/g, "");
  const bytes = createHash("sha1")
    .update(Buffer.from(nsHex, "hex"))
    .update(`outbox:${eventRowId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Build a notification AdapterResolver backed by a ChatAdapterRegistry.
 * Resolves on (tenant_id, platform, workspace_id). The registry lookup
 * is keyed by the channel row's `tenant_id` + `platform` + `workspace_id`
 * triple — exact match only for real chat platforms; returning `null`
 * forces `dispatchEvent` to record a `skipped` delivery with reason
 * `no_adapter`.
 *
 * The `sk_cli` pseudo-platform is the exception: it is never installed
 * per workspace (there is no `chat_workspaces` row for `_cli`), so an
 * exact lookup always misses. It is registered once at boot as a
 * process-global fallback and scopes per tenant via `delivery.tenant_id`,
 * so we fall back to the per-platform fallback adapter for it.
 */
export function makeRegistryAdapterResolver(chatRegistry: ChatAdapterRegistry): AdapterResolver {
  return (channel) => {
    const platform = channel.platform as ChatPlatform;
    const adapter = chatRegistry.get({
      tenant_id: channel.tenant_id,
      platform,
      workspace_id: channel.workspace_id,
    });
    if (!adapter && platform === "sk_cli") {
      return chatRegistry.getFallback("sk_cli");
    }
    return adapter;
  };
}

export interface FanoutInput {
  db: Db;
  boss: PgBoss;
  tenant_id: string;
  event_row_id: number;
  event_type: string;
  payload: unknown;
  event_uuid?: string;
  /** Optional notification adapter resolver. When provided the
   * outbound fanout will also run the notification dispatch path for
   * this event. Leave unset in pure webhook-only contexts. */
  notificationAdapterResolver?: AdapterResolver;
}

export interface FanoutStats {
  matched: number;
  enqueued: number;
  notifications_matched?: number;
  notifications_delivered?: number;
}

const DEFAULT_SEVERITY: Record<string, NotificationSeverity> = {
  "execution.failed": "error",
  "execution.succeeded": "info",
  "execution.aborted": "warn",
  "workflow.updated": "info",
  "patch.proposed": "warn",
  // A workflow changed without anyone asking — the operator learns about it
  // here or not at all: the pending-review list only shows what is still open.
  "patch.applied": "warn",
  "api_key.rotated": "info",
};

function extractSeverity(type: string, payload: unknown): NotificationSeverity {
  if (payload && typeof payload === "object" && "severity" in payload) {
    const s = (payload as { severity?: unknown }).severity;
    if (s === "debug" || s === "info" || s === "warn" || s === "error" || s === "critical") {
      return s;
    }
  }
  return DEFAULT_SEVERITY[type] ?? "info";
}

function extractWorkflowId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "workflow_id" in payload) {
    const w = (payload as { workflow_id?: unknown }).workflow_id;
    if (typeof w === "string") return w;
  }
  return null;
}

const VALID_REQUEST_SOURCES: ReadonlySet<string> = new Set([
  "api",
  "cli",
  "mcp",
  "webhook",
  "tool-chain",
  "scheduler",
  "chat",
]);

function extractRequestSource(payload: unknown): RequestSource | null {
  if (payload && typeof payload === "object" && "request_source" in payload) {
    const r = (payload as { request_source?: unknown }).request_source;
    if (typeof r === "string" && VALID_REQUEST_SOURCES.has(r)) {
      return r as RequestSource;
    }
  }
  return null;
}

export async function fanoutEvent(input: FanoutInput): Promise<FanoutStats> {
  const { db, boss, tenant_id, event_type, payload, event_row_id } = input;
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.tenant_id, tenant_id), eq(subscriptions.active, true)));

  let matched = 0;
  let enqueued = 0;
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    type: event_type,
    timestamp: now,
    data: payload,
  });
  // Idempotency key for downstream delivery. Derive it DETERMINISTICALLY
  // from the stable outbox row id (not randomUUID) so that if the
  // event.fanout job is retried, every re-emitted webhook delivery carries
  // the SAME event_id — the receiver (and our deliveries table) can then
  // dedup, making fanout retries safe instead of duplicate-delivering.
  const eventUuid = input.event_uuid ?? deterministicEventId(event_row_id);

  for (const sub of rows) {
    if (!matchEventPattern(sub.event_pattern, event_type)) continue;
    matched += 1;
    const job: WebhookDeliverJob = {
      tenant_id,
      subscription_id: sub.id,
      event_id: eventUuid,
      event_type,
      body,
      webhook_id: randomUUID(),
      timestamp: now,
      attempt_number: 1,
      outbox_event_id: event_row_id,
    };
    await boss.send(WEBHOOK_DELIVER_QUEUE, job);
    enqueued += 1;
  }

  // --- notification dispatch path (independent of webhook fanout) ---
  let notifications_matched = 0;
  let notifications_delivered = 0;
  try {
    const notifEvent: NotificationEvent = {
      tenant_id,
      type: event_type,
      payload: (payload ?? null) as Record<string, unknown> | null,
      workflow_id: extractWorkflowId(payload),
      severity: extractSeverity(event_type, payload),
      request_source: extractRequestSource(payload),
    };
    const result = await dispatchNotifications(
      {
        db,
        ...(input.notificationAdapterResolver
          ? { resolveAdapter: input.notificationAdapterResolver }
          : {}),
      },
      notifEvent,
    );
    notifications_matched = result.matched;
    notifications_delivered = result.delivered;
  } catch (err) {
    logger.error({
      module: "notifications",
      action: "dispatch.failed",
      msg: "notification dispatch crashed",
      tenant_id,
      event_type,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.debug({
    module: "webhooks.outbound",
    action: "fanout.dispatched",
    msg: "event fanned out",
    tenant_id,
    event_type,
    matched,
    enqueued,
    notifications_matched,
    notifications_delivered,
  });
  return { matched, enqueued, notifications_matched, notifications_delivered };
}

/**
 * Convenience wrapper — read a single outbox row and fan it out.
 * Used by the `event.fanout` queue handler that reacts to outbox
 * NOTIFY pulses. Accepts an optional notification adapter resolver so
 * the worker can hand the outbox event to the notifications dispatch
 * path in addition to the webhook fanout path.
 */
export async function fanoutEventRow(
  db: Db,
  boss: PgBoss,
  event_row_id: number,
  opts: { notificationAdapterResolver?: AdapterResolver } = {},
): Promise<FanoutStats | null> {
  // tenant-filter:exempt — events PK lookup; row's tenant_id is read out and forwarded to fanoutEvent for downstream filtering
  const rows = await db.select().from(events).where(eq(events.id, event_row_id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return await fanoutEvent({
    db,
    boss,
    tenant_id: row.tenant_id,
    event_row_id: row.id,
    event_type: row.type,
    payload: row.payload,
    ...(opts.notificationAdapterResolver
      ? { notificationAdapterResolver: opts.notificationAdapterResolver }
      : {}),
  });
}
