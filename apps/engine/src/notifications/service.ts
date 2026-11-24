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
import { logger } from "../logging/index.ts";
import { canPass, onFailure, onSuccess } from "./circuit-breaker.ts";
import {
  type MatchedRule,
  matchRules,
  type NotificationEvent,
  type NotificationSeverity,
  normalizeSeverity,
  severityMeets,
} from "./matcher.ts";
import { tryAcquire } from "./rate-limit.ts";
import { slackDecisionBlocks } from "./slack-decision-card.ts";

export interface NotificationAdapter {
  readonly platform?: string;
  send(delivery: ChatDelivery): Promise<OutboundSendResult>;
}

export type AdapterResolver = (
  channel: NotificationChannelRow,
) => NotificationAdapter | ChatAdapter | null;

export interface DispatchDeps {
  db: Db;
  resolveAdapter?: AdapterResolver;
  now?: () => number;
}

type DeliveryStatus = "sent" | "rate_limited" | "breaker_open" | "failed" | "skipped";

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
      default_severity: "debug",
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

async function decisionBlocks(db: Db, event: NotificationEvent): Promise<unknown[] | null> {
  try {
    return await slackDecisionBlocks(db, event);
  } catch (err) {
    logger.warn({
      module: "notifications",
      action: "slack_decision_card.failed",
      msg: "could not build the Slack decision card; the plain notification is sent instead",
      tenant_id: event.tenant_id,
      event_type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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

    const channelFloor = normalizeSeverity(channel.default_severity);
    if (!severityMeets(event.severity, channelFloor)) {
      result.outcomes.push({
        rule_id: rule.row.id,
        channel_id: channel.id,
        status: "skipped",
        reason: "below_channel_severity",
      });
      await recordDelivery(db, {
        tenant_id: event.tenant_id,
        rule_id: rule.row.id,
        channel_id: channel.id,
        event,
        severity: rule.severity,
        status: "skipped",
        reason: "below_channel_severity",
      });
      logger.debug({
        module: "notifications",
        action: "channel.below_severity",
        msg: "event severity is below the channel severity floor; delivery skipped",
        tenant_id: event.tenant_id,
        rule_id: rule.row.id,
        channel_id: channel.id,
        event_type: event.type,
        event_severity: event.severity ?? "info",
        channel_severity: channelFloor,
      });
      continue;
    }

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

    const blocks = channel.platform === "slack" ? await decisionBlocks(db, event) : null;
    const delivery: ChatDelivery = {
      tenant_id: event.tenant_id,
      workspace_id: channel.workspace_id,
      channel_id: channel.channel_id,
      kind: "message",
      text: buildText(event, rule.severity),
      ...(blocks ? { blocks } : {}),
      notification: {
        severity: event.severity ?? rule.severity,
        event_type: event.type,
        event_payload: (event.payload ?? null) as Record<string, unknown> | null,
      },
    };

    try {
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
