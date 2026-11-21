import { getConfig } from "../config/loader.ts";
import { errorFields, logger } from "../logging/logger.ts";
import type { Executor } from "./client.ts";
import { admitPersistentRateLimits, rateLimitBucketKey } from "./rate-limits.ts";

export interface WindowLimit {
  readonly max: number;
  readonly windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retry_after_seconds: number;
}

export interface LocalRateLimiter {
  take(key: string, now?: number): RateLimitVerdict;
}

export interface SharedRateLimiter {
  take(db: Executor, key: string): Promise<RateLimitVerdict>;
}

const SHARED_WINDOWS: Readonly<Record<number, "minute" | "ten_minutes">> = {
  60000: "minute",
  600000: "ten_minutes",
};

function configuredSecret(): string {
  try {
    return getConfig().auth.session.secret;
  } catch {
    return "";
  }
}

export function createSharedRateLimiter(input: {
  scope: "desktop_login" | "feedback" | "invite_send";
  name: string;
  limits: WindowLimit;
  local: LocalRateLimiter;
  secret?: () => string;
}): SharedRateLimiter {
  const window = SHARED_WINDOWS[input.limits.windowMs];
  return {
    async take(db, key) {
      const secret = (input.secret ?? configuredSecret)();
      if (!secret || !window) return input.local.take(key);
      try {
        const admitted = await admitPersistentRateLimits(
          [
            {
              bucket_key: rateLimitBucketKey(
                secret,
                input.scope,
                `${input.name}:${input.limits.max}:${key}`,
              ),
              max: input.limits.max,
              window,
            },
          ],
          db,
        );
        return admitted.allowed
          ? { allowed: true, retry_after_seconds: 0 }
          : { allowed: false, retry_after_seconds: admitted.retry_after_seconds };
      } catch (error) {
        logger.warn({
          module: "db",
          action: "rate_limit.shared_unavailable",
          msg: "shared rate limit unavailable, counting in this process only",
          scope: input.scope,
          name: input.name,
          ...errorFields(error),
        });
        return input.local.take(key);
      }
    },
  };
}
