import { useSyncExternalStore } from "react";

export const NAVIGATION_SHEET_BELOW_REM = 68.75;

export const NAVIGATION_SHEET_QUERY = `(width < ${NAVIGATION_SHEET_BELOW_REM}rem)`;

export function navigationIsSheet(widthPx: number, remPx = 16): boolean {
  return widthPx < NAVIGATION_SHEET_BELOW_REM * remPx;
}

function query(): MediaQueryList | null {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(NAVIGATION_SHEET_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  if (!list) return () => {};
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return query()?.matches ?? false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
