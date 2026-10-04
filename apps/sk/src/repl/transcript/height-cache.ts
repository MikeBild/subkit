export interface HeightCacheOptions {
  maxEntries?: number;
}

interface CacheEntry {
  width: number;
  height: number;
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

  invalidate(key: string): void {
    this.map.delete(key);
  }

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
