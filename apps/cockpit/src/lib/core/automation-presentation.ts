import type { components } from "@cli-core/engine-api/openapi";
import type { AutomationAction, AutomationState } from "@shared/workflow-automation.ts";
import type { TranslationKey } from "@/lib/i18n";
import type { ReviewEnvironment } from "@/lib/review-environment";

type WorkflowAuthority = components["schemas"]["WorkflowExecutionAuthority"];
type CockpitAutomationState = AutomationState<WorkflowAuthority>;

export function recommendedAutomationEnvironment(
  preview: { recommended_environment?: { environment: "dev" | "prod" | null } } | null,
): ReviewEnvironment | null {
  return preview?.recommended_environment?.environment ?? null;
}

export const AUTOMATION_STATE_KEYS = {
  invalid: "automation.state.invalid",
  paused: "automation.state.paused",
  apply: "automation.state.apply",
  repair: "automation.state.repair",
  unknown: "automation.state.unknown",
  grant: "automation.state.grant",
  approved: "automation.state.approved",
  manual: "automation.state.manual",
} satisfies Record<CockpitAutomationState["state"], TranslationKey>;

export function automationActionKey(action: AutomationAction): TranslationKey {
  switch (action.kind) {
    case "resume":
      return "automation.action.resume";
    case "apply":
      return "automation.action.apply";
    case "grant":
      return "automation.action.grant";
    case "extend":
      return "automation.action.extend";
    case "view":
      return "automation.action.view";
    case "repair":
      return action.via === "review"
        ? "remedy.reviewRepair"
        : action.via === "auto"
          ? "diagnosis.repair"
          : action.via === "prepare"
            ? "diagnosis.prepare"
            : "remedy.chat";
  }
}

interface CarryOverPreview {
  approval_carries_over: boolean;
  eligible_for_repeated_runs: boolean;
  execution_shape: {
    requests: ReadonlyArray<{
      request_review_truncated?: boolean | null;
      opaque_payload_omitted?: boolean | null;
    }>;
  };
}

export function carryOverChoice(
  preview: CarryOverPreview | null | undefined,
  activation: boolean,
): "adopt" | "review" {
  if (!preview || !activation) return "review";
  const incomplete = preview.execution_shape.requests.some(
    (request) => request.request_review_truncated || request.opaque_payload_omitted,
  );
  return preview.approval_carries_over && preview.eligible_for_repeated_runs && !incomplete
    ? "adopt"
    : "review";
}

export interface AutomationCard {
  titleKey: TranslationKey;
  hintKey: TranslationKey;
  act: "review" | "resume" | "recheck" | "none";
  actionKey: TranslationKey;
  environments: ReviewEnvironment[];
}

export function automationCard(
  state: CockpitAutomationState,
  webhooksActive: number | null | undefined,
): AutomationCard {
  const calm: Pick<AutomationCard, "act" | "actionKey" | "environments"> = {
    act: "none",
    actionKey: "automation.action.view",
    environments: [],
  };
  const review = (
    summary: "repair" | "review" | "apply",
    hintKey: TranslationKey,
    actionKey: TranslationKey,
  ): AutomationCard => ({
    titleKey: `chat.automationCard.${summary}.title`,
    hintKey,
    act: "review",
    actionKey,
    environments:
      state.pendingEnvironments.length > 0 ? state.pendingEnvironments : [state.environment],
  });
  const grantCard = (): AutomationCard => {
    const running = state.triggers.filter((trigger) => !trigger.paused);
    const scheduled = running.some((trigger) => trigger.kind === "schedule");
    const hooked = running.some((trigger) => trigger.kind === "hook") || (webhooksActive ?? 0) > 0;
    return review(
      "review",
      scheduled && !hooked
        ? "chat.automationCard.review.hint.schedule"
        : hooked && !scheduled
          ? "chat.automationCard.review.hint.hook"
          : "chat.automationCard.review.hint.any",
      automationActionKey({ kind: "grant" }),
    );
  };
  switch (state.state) {
    case "approved":
      return {
        ...calm,
        titleKey: "chat.automationCard.authorized.title",
        hintKey: "chat.automationCard.authorized.hint",
      };
    case "invalid":
      return {
        ...calm,
        titleKey: AUTOMATION_STATE_KEYS.invalid,
        hintKey: "automation.headline.invalid",
      };
    case "manual":
      return {
        ...calm,
        titleKey: AUTOMATION_STATE_KEYS.manual,
        hintKey: state.facts.inactive
          ? "automation.headline.inactive"
          : "automation.headline.manual",
      };
    case "paused": {
      const resumable = state.primaryAction?.kind === "resume";
      return {
        ...calm,
        titleKey: AUTOMATION_STATE_KEYS.paused,
        hintKey: resumable ? "automation.headline.paused" : "automation.hookOff",
        act: resumable ? "resume" : "none",
        actionKey: "automation.action.resume",
      };
    }
    case "unknown":
      return {
        ...calm,
        titleKey: "chat.automationCard.unknown.title",
        hintKey: "automation.headline.unknown",
        act: "recheck",
        actionKey: "automation.action.recheck",
      };
    case "apply":
      return review(
        "apply",
        "chat.automationCard.apply.hint",
        automationActionKey({ kind: "apply" }),
      );
    case "repair":
      return review(
        "repair",
        "chat.automationCard.repair.hint",
        "chat.automationCard.repair.action",
      );
    case "grant":
      return grantCard();
  }
}
