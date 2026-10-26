import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import { useWorkflowAutomation } from "@/components/cockpit/automation-panel";
import { FormDialog } from "@/components/cockpit/patterns";
import { type RunWording, RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import { useI18n } from "@/lib/i18n-context";
import { REPORT_WORKFLOW_SLUG, type ReportWorkflow, reportWorkflowOf } from "@/lib/report-problem";

type NoticeKind = "loading" | "notSetUp" | "unreadable";

function Notice({ kind }: { kind: NoticeKind }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      title={t("report.title")}
      error={
        kind === "loading" ? null : t(kind === "notSetUp" ? "report.notSetUp" : "report.unreadable")
      }
      cancelLabel={t("common.close")}
      testId="report-problem-notice"
    >
      {kind === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("report.loading")}
        </p>
      ) : null}
    </FormDialog>
  );
}

function ReportForm({
  workflow,
  permissions,
}: {
  workflow: ReportWorkflow;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const automation = useWorkflowAutomation(workflow.id, workflow, permissions);
  if (automation.failed) return <Notice kind="unreadable" />;
  if (automation.runEnvironment === undefined) return <Notice kind="loading" />;
  if (automation.runEnvironment === null) return <Notice kind="notSetUp" />;
  const wording: RunWording = {
    title: t("report.title"),
    intro: t("report.intro"),
    submit: t("report.submit"),
    started: t("report.sent"),
    refused: t("report.refused"),
    fields: {
      title: { title: t("report.field.title"), description: t("report.field.titleHelp") },
      description: {
        title: t("report.field.description"),
        description: t("report.field.descriptionHelp"),
      },
    },
  };
  return (
    <RunWorkflowDialog
      workflowId={workflow.id}
      workflowName={workflow.name}
      liveEnvironment={automation.runEnvironment}
      openRequest={1}
      wording={wording}
    />
  );
}

export function ReportProblem({ permissions }: { permissions: readonly string[] }) {
  const listing = useQuery({
    queryKey: ["report-problem-workflow"],
    staleTime: 0,
    retry: false,
    queryFn: () =>
      apiRequest<{ items: ReportWorkflow[] }>(
        `/v1/workflows?limit=50&q=${encodeURIComponent(REPORT_WORKFLOW_SLUG)}`,
      ),
  });
  if (listing.isPending) return <Notice kind="loading" />;
  if (listing.isError) return <Notice kind="unreadable" />;
  const workflow = reportWorkflowOf(listing.data.items);
  if (!workflow) return <Notice kind="notSetUp" />;
  return <ReportForm workflow={workflow} permissions={permissions} />;
}
