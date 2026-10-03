import { useEffect, useRef, useState } from "react";

/**
 * Where a loading surface is:
 *
 * - `reserve`: loading, not yet worth showing. The placeholder holds the
 *   final size, invisible — a fast answer arrives without a flash.
 * - `skeleton`: loading long enough to say so. The placeholder shows, and
 *   stays for a minimum once shown, so it never flickers.
 * - `content`: the data.
 */
export type LoadingPhase = "reserve" | "skeleton" | "content";

/** Below this a load shows nothing at all. */
export const SKELETON_DELAY_MS = 150;
/** Once shown, a skeleton stays at least this long. */
export const SKELETON_MIN_MS = 300;

/** The phase for a given moment; pure, so the timing rules are testable. */
export function loadingPhase(input: {
  loading: boolean;
  shownAt: number | null;
  now: number;
  minVisible?: number;
}): LoadingPhase {
  const minVisible = input.minVisible ?? SKELETON_MIN_MS;
  if (input.shownAt !== null && (input.loading || input.now - input.shownAt < minVisible))
    return "skeleton";
  return input.loading ? "reserve" : "content";
}

export function useLoadingPhase(
  loading: boolean,
  { delay = SKELETON_DELAY_MS, minVisible = SKELETON_MIN_MS } = {},
): LoadingPhase {
  const [shownAt, setShownAt] = useState<number | null>(null);
  const shown = useRef<number | null>(null);
  shown.current = shownAt;

  useEffect(() => {
    if (loading) {
      if (shown.current !== null) return;
      const timer = setTimeout(() => setShownAt(Date.now()), delay);
      return () => clearTimeout(timer);
    }
    if (shown.current === null) return;
    const left = minVisible - (Date.now() - shown.current);
    const timer = setTimeout(() => setShownAt(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [loading, delay, minVisible]);

  return loadingPhase({ loading, shownAt, now: Date.now(), minVisible });
}

/**
 * True from the moment a surface's content replaced its loading placeholder,
 * for the rest of its life — the class that fades the content in stays put, so
 * a later re-render never cuts the fade short. Content that was there from the
 * first render never fades.
 */
export function useArrived(phase: LoadingPhase): boolean {
  const seenLoading = useRef(phase !== "content");
  const arrived = useRef(false);
  if (phase !== "content") seenLoading.current = true;
  else if (seenLoading.current) arrived.current = true;
  return arrived.current;
}
