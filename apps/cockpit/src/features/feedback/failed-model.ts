import type { OfflineFailure, OfflineIdentity, OfflineItem } from "@shared/offline-queue.ts";
import type { FeedbackBody } from "./model";

export const FAILED_EXCERPT_MAX = 60;

type QueueItem = OfflineItem<FeedbackBody>;

export interface FailedReport {
  id: string;
  failure: OfflineFailure;
  excerpt: string;
  created_on_device_at: string;
  canResend: boolean;
}

export function canResend(failure: OfflineFailure): boolean {
  return failure === "conflict";
}

export function excerptOf(message: string): string {
  const line = message.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > FAILED_EXCERPT_MAX ? `${line.slice(0, FAILED_EXCERPT_MAX - 1)}…` : line;
}

function mine(item: QueueItem, identity: OfflineIdentity): boolean {
  return item.server === identity.server && item.user_id === identity.user_id;
}

function isFailed(item: QueueItem): item is QueueItem & { failure: OfflineFailure } {
  return item.state === "failed" && item.failure !== null;
}

export function failedReports(
  queue: readonly QueueItem[],
  identity: OfflineIdentity,
): FailedReport[] {
  return queue
    .filter((item) => mine(item, identity))
    .filter(isFailed)
    .sort((a, b) => b.created_on_device_at.localeCompare(a.created_on_device_at))
    .map((item) => ({
      id: item.id,
      failure: item.failure,
      excerpt: excerptOf(item.payload.message),
      created_on_device_at: item.created_on_device_at,
      canResend: canResend(item.failure),
    }));
}

export function resendFailed(
  queue: readonly QueueItem[],
  identity: OfflineIdentity,
  id: string,
  nextId: string,
  now: number,
): QueueItem[] {
  return queue.map((item) =>
    item.id === id && mine(item, identity) && isFailed(item) && canResend(item.failure)
      ? {
          ...item,
          id: nextId,
          payload: { ...item.payload, client_request_id: nextId },
          attempts: 0,
          next_attempt_at: now,
          state: "waiting",
          failure: null,
        }
      : item,
  );
}

export function discardFailed(
  queue: readonly QueueItem[],
  identity: OfflineIdentity,
  id: string,
): QueueItem[] {
  return queue.filter((item) => !(item.id === id && mine(item, identity) && isFailed(item)));
}
