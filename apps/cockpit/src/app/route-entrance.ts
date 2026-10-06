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

export const NO_PAGE = Symbol("no-page");

export function entersRoute(change: {
  previous: unknown;
  next: unknown;
  reducedMotion: boolean;
}): boolean {
  return change.previous !== NO_PAGE && change.previous !== change.next && !change.reducedMotion;
}

export function useRouteEntrance(target: RefObject<HTMLElement | null>, page: unknown): void {
  const previous = useRef<unknown>(NO_PAGE);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = page;
    const element = target.current;
    if (!element || typeof element.animate !== "function") return;
    if (!entersRoute({ previous: before, next: page, reducedMotion: prefersReducedMotion() }))
      return;
    element.animate(ENTRANCE, {
      duration: ROUTE_ENTRANCE_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }, [page, target]);
}

const ONE_PAGE = [/^\/chat(?:\/|$)/];

export function pageOf(pathname: string): string {
  return ONE_PAGE.find((page) => page.test(pathname))?.source ?? pathname;
}
