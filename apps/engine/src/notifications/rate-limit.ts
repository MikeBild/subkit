export interface RateLimitKey {
  tenant_id: string;
  workspace_id: string;
  channel_id: string;
}

interface BucketState {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefillAt: number;
}

const buckets: Map<string, BucketState> = new Map();

export function keyOf(k: RateLimitKey): string {
  return `${k.tenant_id}::${k.workspace_id}::${k.channel_id}`;
}

function refill(bucket: BucketState, now: number): void {
  const elapsed = now - bucket.lastRefillAt;
  if (elapsed <= 0) return;
  const gained = elapsed * bucket.refillPerMs;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + gained);
  bucket.lastRefillAt = now;
}

function getBucket(key: string, capacity: number, now: number): BucketState {
  const refillPerMs = capacity / 60_000;
  const existing = buckets.get(key);
  if (existing) {
    if (existing.capacity !== capacity) {
      existing.capacity = capacity;
      existing.refillPerMs = refillPerMs;
      if (existing.tokens > capacity) existing.tokens = capacity;
    }
    refill(existing, now);
    return existing;
  }
  const fresh: BucketState = {
    tokens: capacity,
    capacity,
    refillPerMs,
    lastRefillAt: now,
  };
  buckets.set(key, fresh);
  return fresh;
}

export interface AcquireResult {
  ok: boolean;
  retryAfterMs?: number;
  tokensRemaining?: number;
}

export function tryAcquire(
  key: RateLimitKey,
  capacityPerMinute: number = 60,
  n: number = 1,
  now: number = Date.now(),
): AcquireResult {
  if (capacityPerMinute <= 0) {
    return { ok: false, retryAfterMs: 60_000 };
  }
  const bucket = getBucket(keyOf(key), capacityPerMinute, now);
  if (bucket.tokens >= n) {
    bucket.tokens -= n;
    return { ok: true, tokensRemaining: bucket.tokens };
  }
  const deficit = n - bucket.tokens;
  const retryAfterMs = Math.ceil(deficit / bucket.refillPerMs);
  return { ok: false, retryAfterMs };
}

export function __resetRateLimiter(): void {
  buckets.clear();
}

export function __peekBucket(key: RateLimitKey): BucketState | undefined {
  return buckets.get(keyOf(key));
}
