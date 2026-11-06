import { useRouter } from "@tanstack/react-router";
import { runOverlaySearch } from "@/pages/runs-model";

function here(next: { list: boolean; runId: string | null }): string {
  const search = runOverlaySearch(window.location.search, next);
  return `${window.location.pathname}${search}${window.location.hash}`;
}

export function useOpenRunSheet(): {
  run(runId: string): void;
  all(): void;
  show(next: { list: boolean; runId: string | null }): void;
} {
  const router = useRouter();
  const show = (next: { list: boolean; runId: string | null }) => router.history.push(here(next));
  return {
    run: (runId) => show({ list: false, runId }),
    all: () => show({ list: true, runId: null }),
    show,
  };
}
