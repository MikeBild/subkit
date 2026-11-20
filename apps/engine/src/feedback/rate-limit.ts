import { createDesktopLoginRateLimiter } from "../auth/index.ts";
import {
  createSharedRateLimiter,
  type SharedRateLimiter,
  type WindowLimit,
} from "../db/shared-rate-limit.ts";

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
