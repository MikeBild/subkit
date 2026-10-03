import { useRouter } from "@tanstack/react-router";
import { runOverlaySearch } from "@/pages/runs-model";

function here(next: { list: boolean; runId: string | null }): string {
  const search = runOverlaySearch(window.location.search, next);
  return `${window.location.pathname}${search}${window.location.hash}`;
}

/**
 * A run's sheet on the page the reader is on (`?run=<id>`), as a browser
 * address: the page underneath, its tab included, stays what it was.
 */
export function runHereHref(runId: string): string {
  return typeof window === "undefined" ? "" : here({ list: false, runId });
}

/** Opens one run's sheet, or the sheet of all runs, over the current page. */
export function useOpenRunSheet(): {
  run(runId: string): void;
  all(): void;
} {
  const router = useRouter();
  return {
    run: (runId) => router.history.push(here({ list: false, runId })),
    all: () => router.history.push(here({ list: true, runId: null })),
  };
}
