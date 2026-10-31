import { ApiError } from "@/api/client";

export type ReviewFailure = "stale" | "expired" | "failed" | "uncertain" | "blocked";

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
