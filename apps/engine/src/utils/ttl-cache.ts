interface TtlCacheOptions {
  maxEntries: number;
  ttlMs: number;
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

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hitCount, misses: this.missCount, size: this.store.size };
  }
}
