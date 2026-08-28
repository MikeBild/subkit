// Lightweight IP-based token-bucket rate limiter.
// No external dependencies — uses an in-memory Map with periodic pruning.

import type { MiddlewareHandler } from "hono";
import { logger } from "../../logging/logger.ts";
import type { AppEnv } from "../openapi.ts";

interface Bucket {
  tokens: number;
  last: number;
}

const DEFAULT_MAX = 100; // requests per window
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const PRUNE_INTERVAL_MS = 60_000;

export interface RateLimitOptions {
  max?: number;
  windowMs?: number;
  /** Number of trusted reverse proxies in front of the engine. The client
   *  IP is read that many entries from the RIGHT of X-Forwarded-For (the
   *  entries our own infra appended), not the leftmost (which the client
   *  controls and can forge to evade the limit). Default 1 — the standard
   *  single Caddy/ingress in front of the engine. */
  trustedProxies?: number;
}

// Resolve the client IP, trusting only the proxy-appended right-hand
// entries of X-Forwarded-For. The leftmost entries are client-supplied and
// must never be trusted for rate-limit keying.
export function resolveClientIp(
  xff: string | undefined,
  realIp: string | undefined,
  hops: number,
): string {
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - hops);
      return parts[idx] ?? "unknown";
    }
  }
  return realIp ?? "unknown";
}

export function rateLimitMiddleware(opts: RateLimitOptions = {}): MiddlewareHandler<AppEnv> {
  const max = opts.max ?? DEFAULT_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const trustedProxies = Math.max(1, opts.trustedProxies ?? 1);
  const buckets = new Map<string, Bucket>();
  let lastPrune = Date.now();

  return async (c, next): Promise<undefined | Response> => {
    // Authentication runs before this middleware. A resolved principal has
    // already paid the credential-validation cost and is governed by tenant,
    // RBAC, and audit controls, so it must not share the anonymous per-IP
    // budget. This is especially important for browser clients: a single
    // cockpit view intentionally fans out into many authenticated reads.
    if (c.get("principal")) {
      await next();
      return undefined;
    }

    const now = Date.now();

    // Periodic prune of expired buckets.
    if (now - lastPrune > PRUNE_INTERVAL_MS) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.last > windowMs) {
          buckets.delete(key);
        }
      }
      lastPrune = now;
    }

    const ip = resolveClientIp(
      c.req.header("x-forwarded-for"),
      c.req.header("x-real-ip"),
      trustedProxies,
    );

    const bucket = buckets.get(ip);
    if (bucket) {
      // Refill tokens based on elapsed time.
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
