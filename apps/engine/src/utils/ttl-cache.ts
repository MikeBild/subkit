// Tiny in-memory cache with TTL and LRU eviction. Used by docs and
// knowledge search to amortise repeated FTS lookups within a
// conversation turn. Not exported beyond the engine — there is no
// distributed coherence story (one process per replica).
//
// LRU is approximated by re-inserting on touch: a Map preserves
// insertion order, so the oldest key is always the first iteration
// target when we need to evict.
//
// Time source is `Date.now()`; tests can override via the optional
// `now` constructor argument. Each cached value carries an `expires_at`
// computed at set-time, so a clock bump inside Date.now() during reads
// is harmless — entries either remain valid or are dropped lazily.

export interface TtlCacheOptions {
  /** Hard size cap; oldest entry is evicted when exceeded. */
  maxEntries: number;
  /** Time-to-live in milliseconds. */
  ttlMs: number;
  /** Optional injectable clock — defaults to `Date.now`. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expires_at: number;
}

export class TtlCache<V> {
  private readonly store: Map<string, Entry<V>> = new Map();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private hitCount = 0;
  private missCount = 0;

  constructor(opts: TtlCacheOptions) {
    this.maxEntries = Math.max(1, opts.maxEntries);
    this.ttlMs = Math.max(1, opts.ttlMs);
    this.now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.missCount += 1;
      return undefined;
    }
    if (entry.expires_at <= this.now()) {
      this.store.delete(key);
      this.missCount += 1;
      return undefined;
    }
    // Refresh recency by reinserting.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hitCount += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expires_at: this.now() + this.ttlMs });
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /**
   * Remove every entry whose key starts with the given prefix. Used by
   * ingest pipelines to drop stale cache entries for a connector or
   * tenant after writing new chunks.
   */
  invalidatePrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }

  /** Snapshot counters; useful for observability and tests. */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hitCount, misses: this.missCount, size: this.store.size };
  }
}
