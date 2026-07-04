// Width-keyed LRU height cache for VirtualTranscript.
//
// VirtualTranscript skips re-measuring rendered messages by remembering
// (key, width) -> height. When the terminal width changes (SIGWINCH)
// the cache is invalidated for the old widths automatically because
// lookups always include the current width. When the theme changes a
// caller can `clear()` to drop everything.
//
// The cache is bounded by `maxEntries`. Once full, the oldest entry
// (by last-touch timestamp) is evicted. 1024 messages × 1 width is a
// generous default — typical sessions are well under 200 entries.

export interface HeightCacheOptions {
  maxEntries?: number;
}

interface CacheEntry {
  width: number;
  height: number;
  /** Monotonic counter — highest value = most recent touch. */
  touch: number;
}

export class HeightCache {
  private readonly maxEntries: number;
  private readonly map = new Map<string, CacheEntry>();
  private tick = 0;

  constructor(opts: HeightCacheOptions = {}) {
    this.maxEntries = Math.max(16, opts.maxEntries ?? 1024);
  }

  get(key: string, width: number): number | undefined {
    const e = this.map.get(key);
    if (!e || e.width !== width) return undefined;
    e.touch = ++this.tick;
    return e.height;
  }

  set(key: string, width: number, height: number): void {
    this.map.set(key, { width, height, touch: ++this.tick });
    if (this.map.size > this.maxEntries) this.evictOldest();
  }

  /** Drop the entry for a given key (e.g. content updated, must remeasure). */
  invalidate(key: string): void {
    this.map.delete(key);
  }

  /** Drop every entry. Use when the theme changes or any global affects measurement. */
  clear(): void {
    this.map.clear();
    this.tick = 0;
  }

  size(): number {
    return this.map.size;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTouch = Number.POSITIVE_INFINITY;
    for (const [k, e] of this.map) {
      if (e.touch < oldestTouch) {
        oldestKey = k;
        oldestTouch = e.touch;
      }
    }
    if (oldestKey != null) this.map.delete(oldestKey);
  }
}
