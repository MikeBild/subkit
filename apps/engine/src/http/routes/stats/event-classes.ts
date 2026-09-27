// Maps a `?class=` value on GET /v1/stats/events to a concrete set of
// `audit_log.action` values. Every action here MUST exist in the
// `AuditAction` constants (apps/engine/src/audit/types.ts) — a class
// that referenced a non-existent action would silently aggregate zero
// rows forever, hiding a real signal.
//
// The original spec table predates the current AuditAction set; these
// are the corrected, verified mappings:
//   - webhook_outbound: the spec named `webhook.outbound.dead_letter` —
//     no such constant. The real terminal/replay actions are
//     delivered / failed / replayed.
//   - notification: the spec named `notification_rule.dispatched` /
//     `.failed` — no such constants. The only runtime notification
//     event is `notification_rule.tested`; the create/update/delete
//     actions are config-change events, not delivery events.
//   - schedule: the spec named `schedule.fired` / `schedule.fire_failed`
//     — the real firing action is `schedule.trigger.fired`.
//
// Existing as a constant is not enough: an action nothing ever WRITES is the
// same zero-row lie, just harder to see. Two had slipped through — each one
// grepped for across `apps/engine/src` by both its constant name and its
// string literal, with tests excluded, and found only in `audit/types.ts` and
// in this file:
//   - `execution.auto_retried` (EXECUTION_AUTO_RETRIED) — no recorder emits
//     it. `execution_lifecycle` keeps `execution.crash_recovered`, which
//     `audit/recorders/execution.ts` does write, so the class stays.
//   - `policy.changed` (POLICY_CHANGED) — no recorder emits it; the policy
//     change that IS recorded is `tool_policy.changed`, from
//     `conversations/tool-policies.ts`, and it is already in the list. The
//     other four `policy` actions all have recorders, so the class stays.
// Both classes therefore keep live actions and remain accepted by `?class=`;
// nothing had to be removed from `EVENT_CLASSES` in schemas.ts.

import { AuditAction } from "../../../audit/index.ts";
import type { EVENT_CLASSES } from "./schemas.ts";

export type EventClass = (typeof EVENT_CLASSES)[number];

export const EVENT_CLASS_ACTIONS: Record<EventClass, string[]> = {
  webhook_outbound: [
    AuditAction.WEBHOOK_OUTBOUND_DELIVERED,
    AuditAction.WEBHOOK_OUTBOUND_FAILED,
    AuditAction.WEBHOOK_OUTBOUND_REPLAYED,
  ],
  webhook_inbound: [AuditAction.WEBHOOK_INBOUND_RECEIVED, AuditAction.WEBHOOK_INBOUND_DENIED],
  chat: [
    AuditAction.CHAT_MESSAGE_RECEIVED,
    AuditAction.CHAT_MESSAGE_SENT,
    AuditAction.CHAT_MESSAGE_DENIED,
  ],
  notification: [AuditAction.NOTIFICATION_RULE_TESTED],
  schedule: [
    AuditAction.SCHEDULE_TRIGGER_FIRED,
    AuditAction.SCHEDULE_TRIGGER_BOUND,
    AuditAction.SCHEDULE_TRIGGER_UNBOUND,
  ],
  self_healing: [
    AuditAction.PATCH_CANDIDATE_PROPOSED,
    AuditAction.PATCH_CANDIDATE_APPROVED,
    AuditAction.PATCH_CANDIDATE_REJECTED,
    AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
  ],
  discovery: [
    AuditAction.SKILL_CANDIDATE_PROPOSED,
    AuditAction.SKILL_CANDIDATE_APPROVED,
    AuditAction.SKILL_CANDIDATE_REJECTED,
    AuditAction.SKILL_CANDIDATE_SUPERSEDED,
  ],
  execution_lifecycle: [AuditAction.EXECUTION_CRASH_RECOVERED],
  policy: [
    AuditAction.POLICY_DENIED,
    AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
    AuditAction.TOOL_POLICY_CONFIRM_COLLAPSED_MCP,
    AuditAction.TOOL_POLICY_CHANGED,
    AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED,
  ],
  external_write: [AuditAction.EXTERNAL_WRITE],
};
