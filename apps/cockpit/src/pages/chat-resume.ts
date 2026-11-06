import type { TranslationKey } from "@/lib/i18n";

interface ResumeTargetLike {
  kind?: string | null;
  name?: string | null;
  environment?: string | null;
}

interface ResumeSummaryLike {
  stage?: string | null;
  pending_approval?: { tool_name: string } | null;
  active_target?: ResumeTargetLike | null;
  focused_run?: { recorded_at: string } | null;
  live_test?: { execution_id: string; status: string } | null;
}

type LiveTestState = "pending" | "running" | "succeeded" | "failed" | "blocked";

export function liveTestState(status: string | null | undefined): LiveTestState {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "aborted":
    case "timed_out":
      return "failed";
    default:
      return "blocked";
  }
}

type Translate = (key: TranslationKey, values?: Record<string, string>) => string;

const SENTENCE_KEYS: Partial<Record<string, TranslationKey>> = {
  workflow_saved: "chat.resume.workflowSaved",
  workflow_open: "chat.resume.workflowOpen",
  awaiting_approval: "chat.resume.settingUp",
  connector_ready_to_save: "chat.resume.connectorReadyToSave",
  connector_drafting: "chat.resume.connectorDrafting",
  workflow_ready_to_commit: "chat.resume.workflowReadyToCommit",
  workflow_drafting: "chat.resume.workflowDrafting",
  connector_saved: "chat.resume.connectorSaved",
};

const NEXT_ACTION_KEYS: Partial<Record<string, TranslationKey>> = {
  workflow_saved: "chat.schedule.effect",
  run_focus: "chat.resume.next.runFocus",
  workflow_open: "chat.resume.next.workflowOpen",
  awaiting_approval: "chat.resume.next.approval",
  connector_drafting: "chat.resume.next.probeConnector",
  connector_ready_to_save: "chat.resume.next.saveConnector",
  workflow_drafting: "chat.resume.next.previewWorkflow",
  workflow_ready_to_commit: "chat.resume.next.commitWorkflow",
  connector_saved: "chat.resume.next.describeWorkflow",
};

const STAGE_KEYS: Partial<Record<string, TranslationKey>> = {
  workflow_saved: "chat.resume.stage.workflowSaved",
  run_focus: "chat.resume.stage.runFocus",
  workflow_open: "chat.resume.stage.workflowOpen",
  onboarding: "chat.context.onboarding",
  awaiting_approval: "chat.resume.stage.awaitingApproval",
  connector_drafting: "chat.resume.stage.connectorDrafting",
  connector_ready_to_save: "chat.resume.stage.connectorReadyToSave",
  connector_saved: "chat.resume.stage.connectorSaved",
  workflow_drafting: "chat.resume.stage.workflowDrafting",
  workflow_ready_to_commit: "chat.resume.stage.workflowReadyToCommit",
};

function resumeTarget(target: ResumeTargetLike | null | undefined, t: Translate): string {
  const kind = target?.kind?.toLowerCase() ?? "none";
  const name = target?.name?.trim();
  const named =
    kind === "connector"
      ? name && name.toLowerCase() !== "none"
        ? t("chat.resume.target.connector", { name })
        : t("chat.resume.target.connectorUnnamed")
      : kind === "workflow"
        ? name && name.toLowerCase() !== "none"
          ? t("chat.resume.target.workflow", { name })
          : t("chat.resume.target.workflowUnnamed")
        : t("chat.resume.target.none");
  const environment = target?.environment?.trim();
  return environment ? t("chat.resume.target.environment", { target: named, environment }) : named;
}

export function resumeSummaryLine(
  resume: ResumeSummaryLike | null | undefined,
  t: Translate,
  formatDate: (iso: string) => string,
): string | null {
  if (!resume) return null;
  if (resume.stage?.toLowerCase() === "run_focus" && resume.focused_run) {
    const date = formatDate(resume.focused_run.recorded_at);
    const name = resume.active_target?.name?.trim();
    return name
      ? t("chat.resume.runFocus", { name, date })
      : t("chat.resume.runFocusUnnamed", { date });
  }
  const key = SENTENCE_KEYS[resume.stage?.toLowerCase() ?? ""];
  if (!key) return null;
  return t(key, { target: resumeTarget(resume.active_target, t) });
}

export function resumeNextAction(stage: string | null | undefined, t: Translate): string {
  const key = NEXT_ACTION_KEYS[stage?.toLowerCase() ?? ""];
  return key ? t(key) : t("chat.context.continue");
}

export function resumeStageLabel(stage: string | null | undefined, t: Translate): string {
  const key = STAGE_KEYS[stage?.toLowerCase() ?? ""];
  return key ? t(key) : t("chat.context.ready");
}
