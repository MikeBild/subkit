import { submitFeedback } from "@/api/feedback";
import { createFeedbackQueue, type FeedbackQueue, type FeedbackQueueItem } from "./offline";
import { queueStore } from "./queue-store";

const QUEUE_NAME = "subkit-feedback-queue";

let shared: FeedbackQueue | null = null;

export function feedbackQueue(): FeedbackQueue {
  shared ??= createFeedbackQueue({
    store: queueStore<FeedbackQueueItem>(QUEUE_NAME),
    send: submitFeedback,
    now: () => Date.now(),
    jitter: () => Math.random(),
  });
  return shared;
}
