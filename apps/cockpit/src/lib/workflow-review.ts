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

export function workflowReviewStorageKey(conversationId: string, elicitationId: string): string {
  return `subkit:workflow-review:${conversationId}:${elicitationId}`;
}
