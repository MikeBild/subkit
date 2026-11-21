import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { apiCall } from "@/api/call";
import { useSession } from "@/app/session";
import { RecordSheet } from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { useI18n } from "@/lib/i18n-context";
import {
  formatRunDuration,
  isExecutionRecord,
  RUN_STATUSES,
  requestSourceLabel,
  runDurationMs,
  runName,
  runsSheetOpen,
} from "@/pages/runs-model";
import { RunsList } from "./runs-list";

export { RunStepIdentityFacts } from "./runs-detail";
export { formatRunDuration, RUN_STATUSES, requestSourceLabel, runDurationMs, runName };

export function useRun(id: string | null, enabled: boolean) {
  const addressed = useQuery({
    queryKey: ["run", id ?? ""],
    enabled: enabled && id !== null,
    queryFn: () => apiCall("get", "/v1/executions/{id}", { path: { id: id ?? "" } }),
  });
  const run = isExecutionRecord(addressed.data) && addressed.data.id === id ? addressed.data : null;
  return {
    run,
    failed: Boolean(addressed.error),
    pending: addressed.isPending,
    retry: () => void addressed.refetch(),
  };
}

export function RunOverlays() {
  const { t } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("execution:read");
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const open = runsSheetOpen(searchStr);
  const sheets = useOpenRunSheet();
  if (!allowed) return null;
  return (
    <RecordSheet
      dock
      open={open}
      onOpenChange={(next) => !next && sheets.close()}
      size="wide"
      title={t("runs.all")}
      titleTestId="runs-sheet-title"
      testId="resource-runs"
      closeTestId="runs-sheet-close"
    >
      {open ? <RunsList onShowRun={sheets.run} /> : null}
    </RecordSheet>
  );
}
