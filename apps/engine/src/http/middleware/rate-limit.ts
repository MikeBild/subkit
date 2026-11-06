import type { MiddlewareHandler } from "hono";
import { logger } from "../../logging/logger.ts";
import type { AppEnv } from "../openapi.ts";

interface Bucket {
  tokens: number;
  last: number;
}

const DEFAULT_MAX = 100;
const DEFAULT_WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;

interface RateLimitOptions {
  max?: number;
  windowMs?: number;
}

export function rateLimitMiddleware(opts: RateLimitOptions = {}): MiddlewareHandler<AppEnv> {
  const max = opts.max ?? DEFAULT_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const buckets = new Map<string, Bucket>();
  let lastPrune = Date.now();

  return async (c, next): Promise<undefined | Response> => {
    if (c.get("principal")) {
      await next();
      return undefined;
    }

    const now = Date.now();

    if (now - lastPrune > PRUNE_INTERVAL_MS) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.last > windowMs) {
          buckets.delete(key);
        }
      }
      lastPrune = now;
    }

    const ip = c.get("client_ip") ?? "unknown";

    const bucket = buckets.get(ip);
    if (bucket) {
      const elapsed = now - bucket.last;
      const refill = Math.floor((elapsed / windowMs) * max);
      bucket.tokens = Math.min(max, bucket.tokens + refill);
      bucket.last = now;

      if (bucket.tokens <= 0) {
        logger.warn({
          module: "http",
          action: "rate_limit_exceeded",
          msg: `rate limit exceeded for ${ip}`,
          ip,
        });
        c.header("Retry-After", String(Math.ceil(windowMs / 1000)));
        return c.json({ code: "rate_limit_exceeded", message: "too many requests" }, 429);
      }
      bucket.tokens--;
    } else {
      buckets.set(ip, { tokens: max - 1, last: now });
    }

    await next();
    return undefined;
  };
}
