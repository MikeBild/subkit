// Bounded transcript renderer with width-keyed height caching.
//
// The CLI's existing transcript pager re-renders every visible message
// on every keystroke; for sessions with hundreds of turns this is fine
// in throughput but blows the React reconciler budget when the operator
// scrolls or types fast. VirtualTranscript holds a *windowed* slice of
// items keyed by `getKey`, computes total transcript height via the
// (key, width) cache, and lets the caller pin to the bottom (default)
// or scroll older items in.
//
// Render contract:
//   - `items` is the source-of-truth transcript array; the component
//     never mutates it.
//   - `estimateHeight(item, width)` is called once per (key, width); the
//     result is cached. Update the key (e.g. include a content hash)
//     when the same row's content changes.
//   - `viewportHeight` is the number of rows available; the component
//     drops earliest items until the rendered slice fits.
//   - `stickyBottom={true}` (default) keeps the most recent items
//     visible. When false, the caller controls scroll via `scrollTop`.
//
// The component does not implement scrolling chrome itself — that's
// `<ScrollView>`'s job. Compose them when scrollback chrome is needed.

import { Box } from "ink";
import { useEffect, useMemo, useRef } from "react";
import { HeightCache } from "../repl/transcript/height-cache.ts";

export interface VirtualTranscriptProps<T> {
  items: T[];
  getKey: (item: T) => string;
  estimateHeight: (item: T, width: number) => number;
  renderItem: (item: T, width: number) => React.ReactNode;
  /** Available rows. Required so the component can cap the rendered slice. */
  viewportHeight: number;
  /** Available columns. Used as the cache key for height memoization. */
  width: number;
  /** Pin to the most recent items. Defaults to true. */
  stickyBottom?: boolean;
  /** Manual scroll position (number of items skipped from the top). */
  scrollTop?: number;
  /** Optional injected cache (tests may pass their own to assert hit/miss). */
  cache?: HeightCache;
  /** Called once per render with metadata about the rendered slice. */
  onRendered?: (info: { renderedKeys: string[]; totalHeight: number }) => void;
}

export function VirtualTranscript<T>({
  items,
  getKey,
  estimateHeight,
  renderItem,
  viewportHeight,
  width,
  stickyBottom = true,
  scrollTop,
  cache: providedCache,
  onRendered,
}: VirtualTranscriptProps<T>): React.ReactElement {
  // Component-owned cache — survives across renders. Tests can inject
  // their own to exercise hit/miss + invalidation.
  const ownedCacheRef = useRef<HeightCache | null>(null);
  if (!ownedCacheRef.current) ownedCacheRef.current = new HeightCache();
  const cache = providedCache ?? ownedCacheRef.current;

  // Heights for every item at the current width. Cache hits skip the
  // `estimateHeight` call.
  const heights = useMemo(() => {
    const out: number[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as T;
      const key = getKey(item);
      const cached = cache.get(key, width);
      if (cached !== undefined) {
        out[i] = cached;
      } else {
        const h = Math.max(1, Math.floor(estimateHeight(item, width)));
        cache.set(key, width, h);
        out[i] = h;
      }
    }
    return out;
  }, [items, width, getKey, estimateHeight, cache]);

  const sliceRange = computeSlice(heights, viewportHeight, { stickyBottom, scrollTop });

  const renderedKeys: string[] = [];
  const renderedNodes: React.ReactNode[] = [];
  let totalHeight = 0;
  for (let i = sliceRange.start; i < sliceRange.end; i++) {
    const item = items[i] as T;
    const key = getKey(item);
    renderedKeys.push(key);
    totalHeight += heights[i] ?? 0;
    renderedNodes.push(<Box key={key}>{renderItem(item, width)}</Box>);
  }

  // Fire side-effects for telemetry / tests after commit.
  useEffect(() => {
    onRendered?.({ renderedKeys, totalHeight });
    // We intentionally re-fire only when the slice or width changes.
  }, [renderedKeys.join("|"), totalHeight, onRendered]);

  return <Box flexDirection="column">{renderedNodes}</Box>;
}

interface SliceRange {
  start: number;
  end: number;
}

function computeSlice(
  heights: readonly number[],
  viewportHeight: number,
  opts: { stickyBottom: boolean; scrollTop?: number | undefined },
): SliceRange {
  const n = heights.length;
  if (n === 0) return { start: 0, end: 0 };
  if (viewportHeight <= 0) return { start: n, end: n };

  if (opts.stickyBottom) {
    // Walk back from the tail accumulating rows until we exceed the
    // viewport, then drop the first overflowing row.
    let used = 0;
    let i = n - 1;
    for (; i >= 0; i--) {
      const next = used + (heights[i] ?? 0);
      if (next > viewportHeight && used > 0) break;
      used = next;
    }
    return { start: Math.max(0, i + 1), end: n };
  }

  const start = Math.max(0, Math.min(n - 1, opts.scrollTop ?? 0));
  let used = 0;
  let end = start;
  for (; end < n; end++) {
    const next = used + (heights[end] ?? 0);
    if (next > viewportHeight && used > 0) break;
    used = next;
  }
  return { start, end };
}

export { computeSlice as _computeSliceForTests };
