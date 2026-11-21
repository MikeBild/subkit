import { useRouter } from "@tanstack/react-router";
import { absolute, runHref } from "@/app/links";
import { runsSheetSearch } from "@/features/runs";

export function useOpenRunSheet(): {
  run(runId: string): void;
  all(): void;
  close(): void;
} {
  const router = useRouter();
  const sheet = (open: boolean) =>
    router.history.push(
      `${window.location.pathname}${runsSheetSearch(window.location.search, open)}${window.location.hash}`,
    );
  return {
    run: (runId) => router.history.push(absolute(runHref(runId))),
    all: () => sheet(true),
    close: () => sheet(false),
  };
}
