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

interface TransitionHandle {
  ready: Promise<unknown>;
  finished: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
}

interface TransitionDocument {
  startViewTransition?: (
    update: (() => Promise<void>) | { update: () => Promise<void>; types: string[] },
  ) => TransitionHandle;
}

let running = false;

function supportsTransitionTypes(): boolean {
  return (
    typeof window !== "undefined" &&
    window.CSS?.supports?.("selector(:active-view-transition-type(a))") === true
  );
}

/**
 * Run one navigation's DOM update, crossfaded when `types` asks for it.
 *
 * A transition the browser skips — a second navigation while one still runs,
 * a hidden tab, a reader who switched it off — rejects its `ready` and
 * `finished` promises with "Transition was skipped". That is no fault: both
 * are caught here, and a navigation that arrives while a transition still
 * runs updates the page directly instead of starting a second one.
 */
export function runViewTransition(
  update: () => Promise<void>,
  types: string[] | false,
  doc: TransitionDocument | undefined = typeof document === "undefined"
    ? undefined
    : (document as unknown as TransitionDocument),
  withTypes: boolean = supportsTransitionTypes(),
): Promise<unknown> {
  const start = doc?.startViewTransition?.bind(doc);
  if (!types || running || !start) return update();
  let transition: TransitionHandle;
  try {
    transition = start(withTypes ? { update, types } : update);
  } catch {
    return update();
  }
  running = true;
  const settle = () => {
    running = false;
  };
  transition.ready.catch(() => undefined);
  transition.finished.then(settle, settle);
  return transition.updateCallbackDone;
}

/** The slice of the router the transition policy reads. */
export interface TransitionRouter {
  shouldViewTransition?: unknown;
  latestLocation: { pathname: string };
  state: { resolvedLocation?: { pathname: string } };
  startViewTransition: (fn: () => Promise<void>) => unknown;
}

/**
 * The router starts its own view transitions but never catches a skipped
 * one; route them through `runViewTransition` instead.
 */
export function guardRouteTransitions(router: TransitionRouter): void {
  router.startViewTransition = (fn) => {
    const wanted = router.shouldViewTransition;
    router.shouldViewTransition = undefined;
    const pathChanged = router.latestLocation.pathname !== router.state.resolvedLocation?.pathname;
    return runViewTransition(fn, wanted === false ? false : routeTransitionTypes({ pathChanged }));
  };
}
