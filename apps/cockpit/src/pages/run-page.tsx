import { useParams, useRouter } from "@tanstack/react-router";
import { absolute, runHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  ActionMenu,
  DataState,
  DetailPage,
  DetailPageLoading,
} from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { runCauseLinks, runName } from "@/pages/runs-model";
import { useRun } from "./runs";
import { RerunAction, RunDetail } from "./runs-detail";
import { isStoppableRun, StopRunAction } from "./runs-stop";

export function RunPage() {
  const { t } = useI18n();
  const router = useRouter();
  const session = useSession();
  const { runId } = useParams({ strict: false }) as { runId?: string };
  const id = runId ? decodeURIComponent(runId) : null;
  const allowed = session.permissions.includes("execution:read");
  const { run, failed, retry } = useRun(id, allowed);
  const back = run?.workflow_id
    ? { to: workflowHref(run.workflow_id), label: runName(run, t) }
    : { to: "/workflows", label: t("nav.workflows") };

  if (!allowed)
    return (
      <div className="p-6">
        <ForbiddenState />
      </div>
    );
  if (!run && failed)
    return (
      <DetailPage testId="run-page" back={back} title={t("ops.run.page")}>
        <DataState
          state="error"
          line={t("runs.detail.loadFailed")}
          onRetry={retry}
          testId="run-detail-missing"
        />
      </DetailPage>
    );
  if (!run) return <DetailPageLoading testId="run-page-loading" back={back} purpose />;

  const canRerun =
    session.permissions.includes("workflow:run") &&
    run.source_kind === "saved" &&
    Boolean(run.workflow_id) &&
    Boolean(run.workflow_version_id);
  const canStop = session.permissions.includes("execution:abort");
  const auditLinks = runCauseLinks(run.id, session.permissions, t);
  return (
    <DetailPage
      testId="run-page"
      back={back}
      title={t("ops.run.page")}
      action={
        canStop && isStoppableRun(run.status) ? (
          <StopRunAction runId={run.id} workflowName={runName(run, t)} />
        ) : canRerun ? (
          <RerunAction
            run={run}
            onStarted={(next) => router.history.push(absolute(runHref(next)))}
          />
        ) : undefined
      }
      menu={
        auditLinks.length > 0 ? (
          <ActionMenu
            items={auditLinks.map((link) => ({
              label: link.label,
              href: absolute(link.href),
              testId: "run-detail-audit",
            }))}
          />
        ) : undefined
      }
    >
      <RunDetail key={run.id} run={run} page />
    </DetailPage>
  );
}
