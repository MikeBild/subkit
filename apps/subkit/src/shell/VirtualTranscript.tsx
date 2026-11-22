import { Box } from "ink";
import { useEffect, useMemo, useRef } from "react";
import { HeightCache } from "../repl/transcript/height-cache.ts";

export interface VirtualTranscriptProps<T> {
  items: T[];
  getKey: (item: T) => string;
  estimateHeight: (item: T, width: number) => number;
  renderItem: (item: T, width: number) => React.ReactNode;
  viewportHeight: number;
  width: number;
  stickyBottom?: boolean;
  scrollTop?: number;
  cache?: HeightCache;
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
  const ownedCacheRef = useRef<HeightCache | null>(null);
  if (!ownedCacheRef.current) ownedCacheRef.current = new HeightCache();
  const cache = providedCache ?? ownedCacheRef.current;

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

  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  useEffect(() => {
    onRenderedRef.current?.({ renderedKeys, totalHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedKeys.join("|"), totalHeight]);

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
