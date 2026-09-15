import type { TranslationKey } from "@/lib/i18n";

/**
 * The German resume line, derived from the parts — never from the prose.
 *
 * The engine composes `one_sentence` out of a stage, a target and the next
 * action, in English. The cockpit used to translate it by comparing the whole
 * composed sentence, byte for byte, against ONE of the seven the engine can
 * produce. Six states were therefore English by construction, and the seventh
 * was English too as soon as the sentence arrived without its appended next
 * action — which is exactly what the screenshot round caught.
 *
 * An equality test on assembled prose cannot carry this: it fails on every
 * wording the other side ever changes, and it fails silently, by leaving the
 * other side's language on the screen. So the German line is built from
 * `stage` and `active_target`, the same structured fields the engine built its
 * own sentence from. They arrive in the cockpit already — no engine change is
 * needed for the reader to be spoken to in their own language.
 *
 * `stage` alone decides the next action as well: the engine's `computeStage`
 * and `computeNextAction` branch on the same inputs in the same order, so the
 * seven stages and the seven actions are one mapping, not two.
 */
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
  awaiting_approval: "chat.resume.awaitingApproval",
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

/** The target as the sentence needs it: named where it has a name, never an id. */
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

/**
 * One sentence about where the conversation stands, in the reader's language.
 *
 * An unknown stage falls back to the neutral line rather than to the engine's
 * English: a state this cockpit has not learned yet is still not a reason to
 * hand the reader another system's wording.
 */
export function resumeSummaryLine(
  resume: ResumeSummaryLike | null | undefined,
  t: Translate,
): string {
  if (!resume) return t("chat.summary");
  if (resume.pending_approval?.tool_name === "ask_user_text") return t("chat.textQuestionSummary");
  const key = SENTENCE_KEYS[resume.stage?.toLowerCase() ?? ""];
  if (!key) return t("chat.summary.inProgress");
  return t(key, { target: resumeTarget(resume.active_target, t) });
}

/** What to do next — read off the same stage, not off the engine's prose. */
export function resumeNextAction(stage: string | null | undefined, t: Translate): string {
  const key = NEXT_ACTION_KEYS[stage?.toLowerCase() ?? ""];
  return key ? t(key) : t("chat.context.continue");
}

/**
 * The stage as a word.
 *
 * The previous map named six stages — authoring, discovery, diagnosis, repair,
 * execution — that the engine has never emitted, so every real stage but
 * `onboarding` fell through to "Bereit". A vocabulary nobody produces is not a
 * translation, it is a guess about a different system.
 */
export function resumeStageLabel(stage: string | null | undefined, t: Translate): string {
  const key = STAGE_KEYS[stage?.toLowerCase() ?? ""];
  return key ? t(key) : t("chat.context.ready");
}
