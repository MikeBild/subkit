import { useEffect, useState } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION);
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function useNow(active: boolean, everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
