import { AuditAction } from "../../audit/index.ts";
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
    AuditAction.TASK_SCHEDULE_CLAIMED,
    AuditAction.TASK_ADMISSION_CHANGED,
  ],
  self_healing: [
    AuditAction.PATCH_CANDIDATE_PROPOSED,
    AuditAction.PATCH_CANDIDATE_APPROVED,
    AuditAction.PATCH_CANDIDATE_REJECTED,
    AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
  ],
  discovery: [
    AuditAction.SKILL_CANDIDATE_PROPOSED,
    AuditAction.SKILL_CANDIDATE_CONTEXT_RECORDED,
    AuditAction.SKILL_CANDIDATE_APPROVED,
    AuditAction.SKILL_CANDIDATE_REJECTED,
    AuditAction.SKILL_CANDIDATE_SUPERSEDED,
  ],
  execution_lifecycle: [
    AuditAction.EXECUTION_CRASH_RECOVERED,
    AuditAction.TASK_RUN_STARTED,
    AuditAction.TASK_RUN_WAITING,
    AuditAction.TASK_RUN_RESUMED,
    AuditAction.TASK_RUN_RESULT_READY,
    AuditAction.TASK_RUN_COMPLETED,
    AuditAction.TASK_RUN_FAILED,
    AuditAction.TASK_RUN_ABORT_REQUESTED,
    AuditAction.TASK_RUN_ABORTED,
  ],
  policy: [
    AuditAction.POLICY_DENIED,
    AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED,
    AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED,
    AuditAction.TOOL_POLICY_CONFIRM_COLLAPSED_MCP,
    AuditAction.TOOL_POLICY_CHANGED,
    AuditAction.TOOL_APPROVAL_RULE_CREATED,
    AuditAction.TOOL_APPROVAL_RULE_DISMISSED,
    AuditAction.TOOL_APPROVAL_RULE_REVOKED,
    AuditAction.TOOL_APPROVAL_RULE_RENEWED,
    AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED,
  ],
  external_write: [AuditAction.EXTERNAL_WRITE],
};
