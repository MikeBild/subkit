import { ApiError } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";

type ReviewFailure = "stale" | "expired" | "failed" | "uncertain" | "blocked";

export function workflowReviewFailure(error: unknown, finalizing: boolean): ReviewFailure {
  if (!(error instanceof ApiError)) return finalizing ? "uncertain" : "failed";
  if (error.status === 409) return "stale";
  if (error.status === 410) return "expired";
  if (error.status === 422) return "blocked";
  if (finalizing && (error.status >= 500 || error.status === 408)) return "uncertain";
  return "failed";
}

const BLOCKED_MESSAGE_KEYS = {
  workflow_not_ready: "reviewWorkflow.blocked.workflow_not_ready",
  preview_failed: "reviewWorkflow.blocked.preview_failed",
  no_prior_approval: "reviewWorkflow.blocked.no_prior_approval",
  pair_schedule_unsupported: "reviewWorkflow.blocked.pair_schedule_unsupported",
} as const;

export type ReviewBlockedMessageKey =
  (typeof BLOCKED_MESSAGE_KEYS)[keyof typeof BLOCKED_MESSAGE_KEYS];

export function workflowReviewBlockedKey(error: unknown): ReviewBlockedMessageKey | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.code) return null;
  return (BLOCKED_MESSAGE_KEYS as Record<string, ReviewBlockedMessageKey>)[error.code] ?? null;
}

export function workflowReviewStorageKey(conversationId: string, elicitationId: string): string {
  return `subkit:workflow-review:${conversationId}:${elicitationId}`;
}

export interface PairReview {
  waitingOn: string | null;
}

export function pairReview(
  pairOn: boolean,
  approver: { kind: string; email?: string } | undefined,
): PairReview | null {
  if (!pairOn) return null;
  return { waitingOn: approver?.kind === "pair" && approver.email ? approver.email : null };
}

export function pairRequestedLine(
  pair: PairReview,
  t: (key: TranslationKey, values?: Record<string, string>) => string,
): string {
  return pair.waitingOn
    ? t("reviewWorkflow.pairRequested", { name: pair.waitingOn })
    : t("reviewWorkflow.pairRequestedAnyone");
}
