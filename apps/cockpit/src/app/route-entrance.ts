import { type RefObject, useLayoutEffect, useRef } from "react";

export const ROUTE_ENTRANCE_MS = 180;

const ENTRANCE: Keyframe[] = [
  { opacity: 0, transform: "translateY(4px)" },
  { opacity: 1, transform: "none" },
];

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function entersRoute(change: {
  previous: string | null;
  next: string;
  reducedMotion: boolean;
}): boolean {
  return change.previous !== null && change.previous !== change.next && !change.reducedMotion;
}

export function useRouteEntrance(target: RefObject<HTMLElement | null>, pathname: string): void {
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = pathname;
    const element = target.current;
    if (!element || typeof element.animate !== "function") return;
    if (!entersRoute({ previous: before, next: pathname, reducedMotion: prefersReducedMotion() }))
      return;
    element.animate(ENTRANCE, {
      duration: ROUTE_ENTRANCE_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }, [pathname, target]);
}
