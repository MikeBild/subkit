import {
  applyOutcome,
  classifyOutcome,
  due,
  enqueue,
  expireOld,
  type OfflineIdentity,
  type OfflineItem,
  releaseAuthHeld,
  summarize,
} from "@shared/offline-queue.ts";
import { type FeedbackBody, feedbackResponse } from "@/features/feedback/model/feedback";
import { discardFailed, type FailedReport, failedReports, resendFailed } from "./failed-model";
import type { QueueStore } from "./queue-store";

export type FeedbackQueueItem = OfflineItem<FeedbackBody>;

export interface FeedbackQueueDeps {
  store: QueueStore<FeedbackQueueItem>;
  send(body: FeedbackBody): Promise<unknown>;
  now(): number;
  jitter(): number;
}

export function createFeedbackQueue(deps: FeedbackQueueDeps) {
  let running: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const load = async () => expireOld(await deps.store.load(), deps.now());

  async function drain(identity: OfflineIdentity): Promise<void> {
    let queue = await load();
    for (;;) {
      const item = due(queue, { ...identity, now: deps.now() });
      if (!item) break;
      let response: ReturnType<typeof feedbackResponse> = { status: 200 };
      try {
        await deps.send({
          ...item.payload,
          client_request_id: item.id,
          created_on_device_at: item.created_on_device_at,
        });
      } catch (error) {
        response = feedbackResponse(error);
      }
      const outcome = classifyOutcome(response);
      queue = applyOutcome(queue, item.id, outcome, deps.now(), deps.jitter());
      await deps.store.save(queue);
      if (outcome.kind !== "delivered") break;
    }
    changed();
  }

  function flush(identity: OfflineIdentity): Promise<void> {
    running ??= drain(identity).finally(() => {
      running = null;
    });
    return running;
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async add(identity: OfflineIdentity, id: string, payload: FeedbackBody): Promise<boolean> {
      const result = enqueue(
        await load(),
        { id, kind: "feedback", payload, ...identity },
        deps.now(),
      );
      if (!result.ok) return false;
      await deps.store.save(result.queue);
      changed();
      return true;
    },
    async signedIn(identity: OfflineIdentity): Promise<void> {
      await deps.store.save(releaseAuthHeld(await load(), identity, deps.now()));
    },
    flush,
    async waiting(identity: OfflineIdentity): Promise<number> {
      const summary = summarize(await load(), identity);
      return summary.waiting + summary.held_auth;
    },
    async failed(identity: OfflineIdentity): Promise<FailedReport[]> {
      return failedReports(await load(), identity);
    },
    async resend(identity: OfflineIdentity, id: string, nextId: string): Promise<void> {
      await deps.store.save(resendFailed(await load(), identity, id, nextId, deps.now()));
      changed();
      await flush(identity);
    },
    async discard(identity: OfflineIdentity, id: string): Promise<void> {
      await deps.store.save(discardFailed(await load(), identity, id));
      changed();
    },
  };
}

export type FeedbackQueue = ReturnType<typeof createFeedbackQueue>;
