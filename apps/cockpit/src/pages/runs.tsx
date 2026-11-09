import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { apiCall } from "@/api/call";
import { absolute, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import { ActionMenu, DataState, RecordSheet } from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { useI18n } from "@/lib/i18n-context";
import {
  formatRunDuration,
  isExecutionRecord,
  RUN_STATUSES,
  requestSourceLabel,
  runCauseLinks,
  runDurationMs,
  runName,
  runOverlayFromUrl,
} from "@/pages/runs-model";

import { RerunAction, RunDetail } from "./runs-detail";
import { RunsList } from "./runs-list";

export { RunStepIdentityFacts } from "./runs-detail";
export { formatRunDuration, RUN_STATUSES, requestSourceLabel, runDurationMs, runName };

function useRun(id: string | null, enabled: boolean) {
  const addressed = useQuery({
    queryKey: ["run", id ?? ""],
    enabled: enabled && id !== null,
    queryFn: () => apiCall("get", "/v1/executions/{id}", { path: { id: id ?? "" } }),
  });
  const run = isExecutionRecord(addressed.data) && addressed.data.id === id ? addressed.data : null;
  return { run, failed: Boolean(addressed.error), retry: () => void addressed.refetch() };
}

export function RunOverlays() {
  const { t } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("execution:read");
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const overlay = useMemo(() => runOverlayFromUrl(searchStr), [searchStr]);
  const { show } = useOpenRunSheet();
  const { run, failed, retry } = useRun(overlay.runId, allowed);
  if (!allowed) return null;
  const open = overlay.list || overlay.runId !== null;
  const canRerun =
    run !== null &&
    session.permissions.includes("workflow:run") &&
    run.source_kind === "saved" &&
    Boolean(run.workflow_id) &&
    Boolean(run.workflow_version_id);
  const auditLinks = run ? runCauseLinks(run.id, session.permissions, t) : [];
  const title = !overlay.runId
    ? t("runs.all")
    : run
      ? t("runs.sheetTitle", { name: runName(run, t) })
      : t("resource.runs.title");
  return (
    <RecordSheet
      dock
      open={open}
      onOpenChange={(next) => !next && show({ list: false, runId: null })}
      size="wide"
      title={
        overlay.runId && run?.workflow_id ? (
          <a
            href={absolute(workflowHref(run.workflow_id))}
            className="min-w-0 underline-offset-4 hover:underline"
            data-testid="run-detail-workflow-link"
          >
            {title}
          </a>
        ) : (
          title
        )
      }
      titleTestId={overlay.runId ? "run-detail-title" : "runs-sheet-title"}
      action={
        overlay.runId && run && canRerun ? (
          <RerunAction run={run} onStarted={(id) => show({ list: overlay.list, runId: id })} />
        ) : undefined
      }
      menu={
        overlay.runId && auditLinks.length > 0 ? (
          <ActionMenu
            items={auditLinks.map((link) => ({
              label: link.label,
              href: absolute(link.href),
              testId: "run-detail-audit",
            }))}
          />
        ) : undefined
      }
      back={
        overlay.list && overlay.runId
          ? { label: t("runs.all"), onClick: () => show({ list: true, runId: null }) }
          : undefined
      }
      testId={overlay.runId ? "run-detail" : "resource-runs"}
      closeTestId={overlay.runId ? "run-detail-close" : "runs-sheet-close"}
    >
      {overlay.list ? (
        <div hidden={overlay.runId !== null}>
          <RunsList onShowRun={(id) => show({ list: true, runId: id })} />
        </div>
      ) : null}
      {overlay.runId === null ? null : run ? (
        <RunDetail run={run} onShowRun={(id) => show({ list: overlay.list, runId: id })} />
      ) : failed ? (
        <DataState
          state="error"
          line={t("runs.detail.loadFailed")}
          onRetry={retry}
          testId="run-detail-missing"
        />
      ) : (
        <DataState state="loading" testId="run-detail-pending" />
      )}
    </RecordSheet>
  );
}
