import { useRouter } from "@tanstack/react-router";
import { runOverlaySearch } from "@/pages/runs-model";

function here(next: { list: boolean; runId: string | null }): string {
  const search = runOverlaySearch(window.location.search, next);
  return `${window.location.pathname}${search}${window.location.hash}`;
}

export function runHereHref(runId: string): string {
  return typeof window === "undefined" ? "" : here({ list: false, runId });
}

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
