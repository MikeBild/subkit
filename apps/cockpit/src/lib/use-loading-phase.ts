import { useEffect, useRef, useState } from "react";

type LoadingPhase = "reserve" | "skeleton" | "content";

const SKELETON_DELAY_MS = 150;
export const SKELETON_MIN_MS = 300;

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

export function useArrived(phase: LoadingPhase): boolean {
  const seenLoading = useRef(phase !== "content");
  const arrived = useRef(false);
  if (phase !== "content") seenLoading.current = true;
  else if (seenLoading.current) arrived.current = true;
  return arrived.current;
}
