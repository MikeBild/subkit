import { createDesktopLoginRateLimiter } from "../auth/index.ts";
import {
  createSharedRateLimiter,
  type Executor,
  type RateLimitVerdict,
  type SharedRateLimiter,
  type WindowLimit,
} from "../db/index.ts";
import {
  ANONYMOUS_FEEDBACK_INSTANCE_LIMIT,
  ANONYMOUS_FEEDBACK_SOURCE_LIMIT,
  type AnonymousFeedbackBucket,
  type AnonymousFeedbackSource,
  anonymousFeedbackKeys,
} from "./core/anonymous.ts";

export const FEEDBACK_RATE_LIMIT = { max: 5, windowMs: 10 * 60_000 } as const;

export type FeedbackRateLimiter = SharedRateLimiter;

export function createFeedbackRateLimiter(
  limits: WindowLimit = FEEDBACK_RATE_LIMIT,
  secret?: () => string,
): FeedbackRateLimiter {
  return createSharedRateLimiter({
    scope: "feedback",
    name: "submit",
    limits,
    local: createDesktopLoginRateLimiter(limits),
    ...(secret ? { secret } : {}),
  });
}

export interface AnonymousFeedbackRateLimiter {
  take(db: Executor, source: AnonymousFeedbackSource): Promise<RateLimitVerdict>;
}

export const ANONYMOUS_FEEDBACK_LIMITS: Readonly<Record<AnonymousFeedbackBucket, WindowLimit>> = {
  ip: ANONYMOUS_FEEDBACK_SOURCE_LIMIT,
  device: ANONYMOUS_FEEDBACK_SOURCE_LIMIT,
  instance: ANONYMOUS_FEEDBACK_INSTANCE_LIMIT,
};

export function createAnonymousFeedbackRateLimiter(
  limits: Readonly<Record<AnonymousFeedbackBucket, WindowLimit>> = ANONYMOUS_FEEDBACK_LIMITS,
  secret?: () => string,
): AnonymousFeedbackRateLimiter {
  const limiter = (bucket: AnonymousFeedbackBucket) =>
    createSharedRateLimiter({
      scope: "feedback",
      name: `anonymous_${bucket}`,
      limits: limits[bucket],
      local: createDesktopLoginRateLimiter(limits[bucket]),
      ...(secret ? { secret } : {}),
    });
  const buckets: Record<AnonymousFeedbackBucket, SharedRateLimiter> = {
    ip: limiter("ip"),
    device: limiter("device"),
    instance: limiter("instance"),
  };
  return {
    async take(db, source) {
      for (const { bucket, key } of anonymousFeedbackKeys(source)) {
        const verdict = await buckets[bucket].take(db, key);
        if (!verdict.allowed) return verdict;
      }
      return { allowed: true, retry_after_seconds: 0 };
    },
  };
}
