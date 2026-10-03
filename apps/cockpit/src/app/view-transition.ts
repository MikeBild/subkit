// Which navigations crossfade the content area (View Transitions).
//
// Only a change of page does. A run sheet (`?run=`), a tab (`?tab=`) or a
// filter changes the query alone; fading the whole page for it would make
// the sheet's own slide and the list underneath flicker. A reader who asked
// for reduced motion gets no transition at all.

export const ROUTE_TRANSITION = "route";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function routeTransitionTypes(change: {
  pathChanged: boolean;
  reducedMotion?: boolean;
}): string[] | false {
  if (!change.pathChanged) return false;
  if (change.reducedMotion ?? prefersReducedMotion()) return false;
  return [ROUTE_TRANSITION];
}

/** The router's `defaultViewTransition`. */
export const routeViewTransition = {
  types: ({ pathChanged }: { pathChanged: boolean }) => routeTransitionTypes({ pathChanged }),
};
