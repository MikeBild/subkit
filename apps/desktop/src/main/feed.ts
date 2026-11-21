import type { SseFrame } from "@shared/sse.ts";
import type { Session } from "electron";
import {
  type AttentionItem,
  hintPending,
  hintRetryDelay,
  planNotifications,
} from "../shared/attention.ts";
import { runEventStream, type StreamStatus } from "../shared/event-stream.ts";
import type { Profile } from "../shared/profiles.ts";
import {
  type AuthFailure,
  apiUrl,
  attentionHint,
  type DeliveryMemory,
  deliveryNow,
  EVENTS_STREAM_PATH,
  helloHeartbeat,
  idleTimeoutFor,
  NO_DELIVERY_MEMORY,
  rememberDelivery,
  streamReaction,
} from "../shared/server-contract.ts";
import { fetchAttention } from "./server-client.ts";

const EVENT_SETTLE_MS = 400;
export const BACKGROUND_REFRESH_MS = 60_000;

export interface FeedHooks {
  session: Session;
  profile(): (Profile & { cockpitPath: string }) | null;
  muted(): boolean;
  saveProgress(patch: Partial<Pick<Profile, "lastEventId" | "notifiedIds" | "baselineDone">>): void;
  onItems(items: AttentionItem[], notify: AttentionItem[], summary: boolean): void;
  onStatus(status: StreamStatus): void;
  onAuthFailure(failure: AuthFailure): void;
  onEvent(name: string, data: string): void;
  onError(scope: string, error: unknown): void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class AttentionFeed {
  private readonly controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private settle: ReturnType<typeof setTimeout> | null = null;
  private background: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs: number | null = null;
  private delivery: DeliveryMemory = NO_DELIVERY_MEMORY;
  private lastDelivery: ReturnType<typeof deliveryNow> = null;
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly hooks: FeedHooks) {}

  start(): void {
    const profile = this.hooks.profile();
    if (!profile) return;
    const { session } = this.hooks;
    void runEventStream({
      url: apiUrl(profile.serverOrigin, profile.cockpitPath, EVENTS_STREAM_PATH),
      lastEventId: profile.lastEventId,
      signal: this.controller.signal,
      idleTimeoutMs: () => idleTimeoutFor(this.heartbeatMs),
      deps: {
        fetch: (url, init) =>
          session.fetch(url, {
            headers: init.headers,
            signal: init.signal,
            credentials: "include",
            redirect: "error",
            cache: "no-store",
          }),
        sleep,
        jitter: () => Math.random(),
      },
      onEvent: (event) => this.onEvent(event),
      onStatus: (status) => {
        this.watch(status === "online");
        if (status === "expired" || status === "revoked") this.hooks.onAuthFailure(status);
        else this.hooks.onStatus(status);
      },
      onError: (error) => this.hooks.onError("events.stream", error),
    });
  }

  stop(): void {
    if (this.settle) clearTimeout(this.settle);
    this.watch(false);
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.controller.abort();
  }

  refresh(announce = false, hintId: string | null = null, attempt = 0): void {
    this.queue = this.queue
      .then(() => this.sync(announce, hintId, attempt))
      .catch((error) => this.hooks.onError("events.attention", error));
  }

  private watch(online: boolean): void {
    if (online === (this.background !== null)) return;
    if (this.background) clearInterval(this.background);
    this.background = online ? setInterval(() => this.refresh(true), BACKGROUND_REFRESH_MS) : null;
  }

  private onEvent(event: SseFrame): void {
    if (event.id) this.hooks.saveProgress({ lastEventId: event.id });
    this.delivery = rememberDelivery(this.delivery, event.event, event.data, Date.now());
    this.hooks.onEvent(event.event, event.data);
    const reaction = streamReaction(event.event);
    if (reaction === "ignore" || reaction === "shutdown") return;
    if (reaction === "sync") {
      this.heartbeatMs = helloHeartbeat(event.data);
      this.refresh();
      return;
    }
    if (reaction === "session") {
      this.refresh();
      return;
    }
    const hint = attentionHint(event.data);
    if (hint) {
      this.refresh(true, hint);
      return;
    }
    this.settle ??= setTimeout(() => {
      this.settle = null;
      this.refresh(true);
    }, EVENT_SETTLE_MS);
  }

  private retryLater(hintId: string, attempt: number): void {
    const delay = hintRetryDelay(attempt);
    const waiting = this.retries.get(hintId);
    if (waiting) clearTimeout(waiting);
    this.retries.delete(hintId);
    if (delay === null) return;
    this.retries.set(
      hintId,
      setTimeout(() => {
        this.retries.delete(hintId);
        this.refresh(true, hintId, attempt + 1);
      }, delay),
    );
  }

  private async sync(announce: boolean, hintId: string | null, attempt: number): Promise<void> {
    const profile = this.hooks.profile();
    if (!profile || this.controller.signal.aborted) return;
    const result = await fetchAttention(
      this.hooks.session,
      profile.serverOrigin,
      profile.cockpitPath,
    );
    if (this.controller.signal.aborted) return;
    if (!result.ok) {
      if (result.failure !== "unavailable") this.hooks.onAuthFailure(result.failure);
      return;
    }
    const current = this.hooks.profile();
    if (!current) return;
    if (announce && hintId !== null && hintPending(result.items, hintId))
      this.retryLater(hintId, attempt);
    const delivery = deliveryNow(this.delivery, Date.now());
    const plan = planNotifications({
      items: result.items,
      notifiedIds: current.notifiedIds,
      baselineDone: current.baselineDone,
      announce,
      hintId,
      muted: this.hooks.muted(),
      delivery,
      released: this.lastDelivery !== null && delivery === null,
    });
    if (announce) this.lastDelivery = delivery;
    this.hooks.saveProgress({ notifiedIds: plan.notifiedIds, baselineDone: plan.baselineDone });
    this.hooks.onItems(result.items, plan.notify, plan.summary);
  }
}
