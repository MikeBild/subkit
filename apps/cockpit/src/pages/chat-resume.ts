import type { TranslationKey } from "@/lib/i18n";

export interface ResumeTargetLike {
  kind?: string | null;
  name?: string | null;
  environment?: string | null;
}

export interface ResumeSummaryLike {
  stage?: string | null;
  pending_approval?: { tool_name: string } | null;
  active_target?: ResumeTargetLike | null;
}

type Translate = (key: TranslationKey, values?: Record<string, string>) => string;

const SENTENCE_KEYS: Partial<Record<string, TranslationKey>> = {
  workflow_saved: "chat.resume.workflowSaved",
  awaiting_approval: "chat.resume.settingUp",
  connector_ready_to_save: "chat.resume.connectorReadyToSave",
  connector_drafting: "chat.resume.connectorDrafting",
  workflow_ready_to_commit: "chat.resume.workflowReadyToCommit",
  workflow_drafting: "chat.resume.workflowDrafting",
  connector_saved: "chat.resume.connectorSaved",
};

const NEXT_ACTION_KEYS: Partial<Record<string, TranslationKey>> = {
  workflow_saved: "chat.schedule.effect",
  awaiting_approval: "chat.resume.next.approval",
  connector_drafting: "chat.resume.next.probeConnector",
  connector_ready_to_save: "chat.resume.next.saveConnector",
  workflow_drafting: "chat.resume.next.previewWorkflow",
  workflow_ready_to_commit: "chat.resume.next.commitWorkflow",
  connector_saved: "chat.resume.next.describeWorkflow",
};

const STAGE_KEYS: Partial<Record<string, TranslationKey>> = {
  workflow_saved: "chat.resume.stage.workflowSaved",
  onboarding: "chat.context.onboarding",
  awaiting_approval: "chat.resume.stage.awaitingApproval",
  connector_drafting: "chat.resume.stage.connectorDrafting",
  connector_ready_to_save: "chat.resume.stage.connectorReadyToSave",
  connector_saved: "chat.resume.stage.connectorSaved",
  workflow_drafting: "chat.resume.stage.workflowDrafting",
  workflow_ready_to_commit: "chat.resume.stage.workflowReadyToCommit",
};

export function resumeTarget(target: ResumeTargetLike | null | undefined, t: Translate): string {
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
): string | null {
  if (!resume) return null;
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
