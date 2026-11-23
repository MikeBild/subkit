import type { components } from "@cli-core/engine-api/openapi";
import { z } from "zod";

export const AttentionReasonSchema = z.enum([
  "awaiting_answer",
  "execution_authority_required",
  "execution_authority_expired",
  "execution_authority_exhausted",
  "execution_authority_revoked",
  "execution_authority_changed",
  "input_required",
  "version_awaiting_approval",
  "version_needs_repair",
  "approval_expiring",
  "schedule_auto_paused",
  "scheduler_stale",
  "failing",
  "patch_proposed",
  "needs_reauth",
  "needs_update",
  "degraded",
  "unhealthy",
  "refresh_refused",
  "refresh_failed",
  "expired_no_refresh",
  "secret_unreadable",
  "secret_prepared",
  "skills_proposed",
  "intake_collected",
  "spend_warning",
  "spend_limit_reached",
  "spend_limit_unset",
  "ai_access_missing",
  "model_tools_missing",
  "risk_critical",
  "task_run_failed",
  "task_result_ready",
  "task_grant_required",
  "task_grant_expiring",
  "task_owner_unavailable",
  "pair_approval_requested",
  "device_offline_waiting",
  "local_confirmation_needed",
  "device_permission_missing",
  "device_handover_waiting",
  "knowledge_review_due",
  "folder_changed",
]);
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

type GeneratedAttention = components["schemas"]["AttentionV1"];
type GeneratedItem = components["schemas"]["AttentionItem"];

export type AttentionItem = Omit<GeneratedItem, "reason"> & { reason: AttentionReason };
export type SnoozedAttentionItem = AttentionItem & {
  attention_key: string;
  snoozed_until: string;
};
export type Attention = Omit<GeneratedAttention, "items"> & {
  items: AttentionItem[];
  snoozed: SnoozedAttentionItem[];
};

export const SnoozeAttentionBodySchema = z
  .object({
    attention_key: z.string().min(1).max(300),
    until: z.string().datetime({ offset: true }),
  })
  .strict();
export type SnoozeAttentionBody = z.infer<typeof SnoozeAttentionBodySchema>;

export const UnsnoozeAttentionBodySchema = z
  .object({ attention_key: z.string().min(1).max(300) })
  .strict();

export const AttentionSnoozeSchema = z.object({
  attention_key: z.string(),
  snoozed: z.boolean(),
  until: z.string().nullable(),
});
export type AttentionSnooze = z.infer<typeof AttentionSnoozeSchema>;
