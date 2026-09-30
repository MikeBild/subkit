// P-GC5: notification dispatch service.
//
// `dispatchEvent(db, event)` is the top-level entry point called from
// the outbox fanout worker. For each matching rule it resolves (or
// auto-creates) a `notification_channels` row, passes the rate limit
// gate, passes the circuit breaker gate, and then invokes the supplied
// chat adapter. Every outcome writes a `notification_deliveries` row
// and an audit entry, reusing existing audit actions:
//
//   - sent               → CHAT_MESSAGE_SENT
//   - rate_limited       → CHAT_MESSAGE_DENIED
//   - breaker_open       → CHAT_MESSAGE_DENIED
//   - failed             → WEBHOOK_OUTBOUND_FAILED
//
// The adapter is injected so tests (and the real fanout worker) can
// swap in a fake or a platform-specific bundle. When no adapter is
// provided the service records a `deliveries` row with status
// `skipped` and does not call the adapter. An adapter that reports it
// skipped the event (the sk CLI inbox passing on a non-actionable event)
// likewise yields a `skipped` row and no audit entry: nothing was sent.

import { and, eq } from "drizzle-orm";
import { audit } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ChatAdapter } from "../chat/adapter.ts";
import { deliver as chatDeliver } from "../chat/dispatcher.ts";
import type { ChatDelivery, OutboundSendResult } from "../chat/types.ts";
import type { Db } from "../db/client.ts";
import {
  type NotificationChannelRow,
  notificationChannels,
  notificationDeliveries,
} from "../db/schema/notifications.ts";
import { logger } from "../logging/logger.ts";
import { canPass, onFailure, onSuccess } from "./circuit-breaker.ts";
import {
  type MatchedRule,
  matchRules,
  type NotificationEvent,
  type NotificationSeverity,
} from "./matcher.ts";
import { tryAcquire } from "./rate-limit.ts";

/**
 * Minimal chat-adapter surface used by the notification dispatcher.
 * A full `ChatAdapter` satisfies it, as does the fake used in tests.
 */
export interface NotificationAdapter {
  readonly platform?: string;
  send(delivery: ChatDelivery): Promise<OutboundSendResult>;
}

/** Resolver that maps a rule to an adapter. Tests pass a fake. */
export type AdapterResolver = (
  channel: NotificationChannelRow,
) => NotificationAdapter | ChatAdapter | null;

export interface DispatchDeps {
  db: Db;
  resolveAdapter?: AdapterResolver;
  /** Override for deterministic tests. */
  now?: () => number;
}

export type DeliveryStatus = "sent" | "rate_limited" | "breaker_open" | "failed" | "skipped";

export interface DeliveryOutcome {
  rule_id: string;
  channel_id: string;
  status: DeliveryStatus;
  reason?: string;
  error?: string;
}

export interface DispatchResult {
  matched: number;
  delivered: number;
  outcomes: DeliveryOutcome[];
}

/**
 * Look up (or create on first use) the channel row pointed at by a
 * rule. Rules store plain `(workspace_id, channel_id)` strings so a
 * single channel row can serve multiple rules without duplication.
 */
async function ensureChannel(
  db: Db,
  tenant_id: string,
  rule: MatchedRule["row"],
  platformHint: string,
): Promise<NotificationChannelRow> {
  const existing = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.tenant_id, tenant_id),
        eq(notificationChannels.workspace_id, rule.target_workspace_id),
        eq(notificationChannels.channel_id, rule.target_channel_id),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(notificationChannels)
    .values({
      tenant_id,
      workspace_id: rule.target_workspace_id,
      channel_id: rule.target_channel_id,
      platform: platformHint,
      default_severity: rule.severity,
      rate_limit_per_minute: 60,
      circuit_state: "closed",
      consecutive_failures: 0,
      active: true,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("notifications: failed to create channel row");
  return row;
}

function buildText(event: NotificationEvent, severity: NotificationSeverity): string {
  const head = `[${severity.toUpperCase()}] ${event.type}`;
  const wf = event.workflow_id ?? event.workflow_slug;
  const tail = wf ? ` (workflow=${wf})` : "";
  return head + tail;
}

async function recordDelivery(
  db: Db,
  params: {
    tenant_id: string;
    rule_id: string;
    channel_id: string;
    event: NotificationEvent;
    severity: NotificationSeverity;
    status: DeliveryStatus;
    reason?: string;
    error?: string;
  },
): Promise<void> {
  await db.insert(notificationDeliveries).values({
    tenant_id: params.tenant_id,
    rule_id: params.rule_id,
    channel_id: params.channel_id,
    event_type: params.event.type,
    event_payload: (params.event.payload ?? null) as unknown as Record<string, unknown> | null,
    severity: params.severity,
    status: params.status,
    reason: params.reason ?? null,
    error: params.error ?? null,
  });
}

function auditOutcome(
  tenant_id: string,
  outcome: DeliveryOutcome,
  event: NotificationEvent,
  db: Db,
): void {
  const meta = {
    rule_id: outcome.rule_id,
    channel_id: outcome.channel_id,
    event_type: event.type,
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
  if (outcome.status === "sent") {
    audit(
      {
        tenant_id,
        action: AuditAction.CHAT_MESSAGE_SENT,
        resource_type: "notification_delivery",
        resource_id: outcome.channel_id,
        result: "success",
        metadata: meta,
      },
      db,
    );
    return;
  }
  if (outcome.status === "rate_limited" || outcome.status === "breaker_open") {
    audit(
      {
        tenant_id,
        action: AuditAction.CHAT_MESSAGE_DENIED,
        resource_type: "notification_delivery",
        resource_id: outcome.channel_id,
        result: "denied",
        reason: outcome.reason ?? outcome.status,
        metadata: meta,
      },
      db,
    );
    return;
  }
  if (outcome.status === "failed") {
    audit(
      {
        tenant_id,
        action: AuditAction.WEBHOOK_OUTBOUND_FAILED,
        resource_type: "notification_delivery",
        resource_id: outcome.channel_id,
        result: "error",
        reason: outcome.error ?? "adapter_failed",
        metadata: meta,
      },
      db,
    );
  }
}

/**
 * Entry point used by the outbox fanout worker. Matches rules, gates
 * each dispatch through the rate limiter + circuit breaker, and
 * forwards approved deliveries to the supplied adapter. Always
 * resolves (never throws) — per-rule failures are logged and recorded
 * as `failed` outcomes.
 */
export async function dispatchEvent(
  deps: DispatchDeps,
  event: NotificationEvent,
): Promise<DispatchResult> {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();

  const rules = await matchRules(db, event.tenant_id, event);
  const result: DispatchResult = { matched: rules.length, delivered: 0, outcomes: [] };
  if (rules.length === 0) return result;

  for (const rule of rules) {
    let channel: NotificationChannelRow;
    // Derive the channel platform from the rule's target. The default
    // sk CLI inbox rule targets the reserved `_cli` workspace; every
    // other rule targets a real chat workspace (Slack is the only
    // platform that auto-creates a channel row today). Hardcoding
    // "slack" here previously mislabeled the sk_cli channel and routed
    // a local-insert delivery through the full chat adapter path.
    const platformHint = rule.row.target_workspace_id === "_cli" ? "sk_cli" : "slack";
    try {
      channel = await ensureChannel(db, event.tenant_id, rule.row, platformHint);
    } catch (err) {
      logger.error({
        module: "notifications",
        action: "channel.ensure_failed",
        msg: "failed to resolve channel row",
        tenant_id: event.tenant_id,
        rule_id: rule.row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!channel.active) {
      const outcome: DeliveryOutcome = {
        rule_id: rule.row.id,
        channel_id: channel.id,
        status: "skipped",
        reason: "channel_inactive",
      };
      result.outcomes.push(outcome);
      await recordDelivery(db, {
        tenant_id: event.tenant_id,
        rule_id: rule.row.id,
        channel_id: channel.id,
        event,
        severity: rule.severity,
        status: "skipped",
        reason: "channel_inactive",
      });
      continue;
    }

    // The sk CLI inbox is a local INSERT — no remote API to throttle and
    // no transient endpoint to circuit-break. Skip both gates so a
    // healthy CLI inbox never records a spurious `rate_limited` /
    // `breaker_open` outcome. Real chat platforms still pass through.
    const isLocalInbox = channel.platform === "sk_cli";

    if (!isLocalInbox) {
      const breakerCheck = canPass(channel, now);
      if (!breakerCheck.allowed) {
        const outcome: DeliveryOutcome = {
          rule_id: rule.row.id,
          channel_id: channel.id,
          status: "breaker_open",
          reason: "circuit_open",
        };
        result.outcomes.push(outcome);
        await recordDelivery(db, {
          tenant_id: event.tenant_id,
          rule_id: rule.row.id,
          channel_id: channel.id,
          event,
          severity: rule.severity,
          status: "breaker_open",
          reason: "circuit_open",
        });
        auditOutcome(event.tenant_id, outcome, event, db);
        continue;
      }

      const acquired = tryAcquire(
        {
          tenant_id: event.tenant_id,
          workspace_id: channel.workspace_id,
          channel_id: channel.channel_id,
        },
        channel.rate_limit_per_minute ?? 60,
        1,
        now,
      );
      if (!acquired.ok) {
        const outcome: DeliveryOutcome = {
          rule_id: rule.row.id,
          channel_id: channel.id,
          status: "rate_limited",
          reason: `retry_after_ms=${acquired.retryAfterMs ?? 0}`,
        };
        result.outcomes.push(outcome);
        await recordDelivery(db, {
          tenant_id: event.tenant_id,
          rule_id: rule.row.id,
          channel_id: channel.id,
          event,
          severity: rule.severity,
          status: "rate_limited",
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        });
        auditOutcome(event.tenant_id, outcome, event, db);
        continue;
      }
    }

    const adapter = deps.resolveAdapter?.(channel) ?? null;
    if (!adapter) {
      const outcome: DeliveryOutcome = {
        rule_id: rule.row.id,
        channel_id: channel.id,
        status: "skipped",
        reason: "no_adapter",
      };
      result.outcomes.push(outcome);
      await recordDelivery(db, {
        tenant_id: event.tenant_id,
        rule_id: rule.row.id,
        channel_id: channel.id,
        event,
        severity: rule.severity,
        status: "skipped",
        reason: "no_adapter",
      });
      continue;
    }

    const delivery: ChatDelivery = {
      tenant_id: event.tenant_id,
      workspace_id: channel.workspace_id,
      channel_id: channel.channel_id,
      kind: "message",
      text: buildText(event, rule.severity),
      notification: {
        // The CLI inbox is a consumer-facing queue, so it carries the EVENT's
        // own severity (e.g. connector.auth_failed = "error"), not the rule's
        // matching floor — otherwise a critical alert would read as "info".
        // `rule.severity` (the floor) still drives the deliveries audit row and
        // the Slack message header below, unchanged.
        severity: event.severity ?? rule.severity,
        event_type: event.type,
        event_payload: (event.payload ?? null) as Record<string, unknown> | null,
      },
    };

    try {
      // Route real chat platforms through the chat dispatcher's shared
      // `deliver` helper so metrics line up with conversation-driven
      // sends. The `sk_cli` adapter is a local INSERT (not a full
      // ChatAdapter — it has no verify/receive/update/sendApproval), so
      // it is invoked directly via the minimal `send` interface, the
      // same path test doubles use.
      const sendResult: OutboundSendResult =
        adapter.platform && adapter.platform !== "sk_cli"
          ? await chatDeliver(adapter as unknown as ChatAdapter, delivery)
          : await adapter.send(delivery);
      if ("skipped" in sendResult) {
        const outcome: DeliveryOutcome = {
          rule_id: rule.row.id,
          channel_id: channel.id,
          status: "skipped",
          reason: sendResult.skipped,
        };
        result.outcomes.push(outcome);
        await recordDelivery(db, {
          tenant_id: event.tenant_id,
          rule_id: rule.row.id,
          channel_id: channel.id,
          event,
          severity: rule.severity,
          status: "skipped",
          reason: sendResult.skipped,
        });
        continue;
      }
      await onSuccess(db, channel.id);
      const outcome: DeliveryOutcome = {
        rule_id: rule.row.id,
        channel_id: channel.id,
        status: "sent",
      };
      result.outcomes.push(outcome);
      result.delivered += 1;
      await recordDelivery(db, {
        tenant_id: event.tenant_id,
        rule_id: rule.row.id,
        channel_id: channel.id,
        event,
        severity: rule.severity,
        status: "sent",
      });
      auditOutcome(event.tenant_id, outcome, event, db);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await onFailure(db, channel, now);
      const outcome: DeliveryOutcome = {
        rule_id: rule.row.id,
        channel_id: channel.id,
        status: "failed",
        error: errMsg,
      };
      result.outcomes.push(outcome);
      await recordDelivery(db, {
        tenant_id: event.tenant_id,
        rule_id: rule.row.id,
        channel_id: channel.id,
        event,
        severity: rule.severity,
        status: "failed",
        error: errMsg,
      });
      auditOutcome(event.tenant_id, outcome, event, db);
    }
  }

  return result;
}

/** Helper to list delivery rows for the HTTP route. */
export async function listDeliveries(
  db: Db,
  tenant_id: string,
  opts: { limit?: number; offset?: number; status?: DeliveryStatus } = {},
): Promise<Array<typeof notificationDeliveries.$inferSelect>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const tenantWhereClauses = [eq(notificationDeliveries.tenant_id, tenant_id)];
  if (opts.status) {
    tenantWhereClauses.push(eq(notificationDeliveries.status, opts.status));
  }
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(tenantWhereClauses.length === 1 ? tenantWhereClauses[0] : and(...tenantWhereClauses))
    .limit(limit)
    .offset(offset);
  return rows;
}
