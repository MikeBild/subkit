import type {
  AutomationInputs as SharedAutomationInputs,
  AutomationState as SharedAutomationState,
} from "@shared/workflow-automation.ts";
import type { WorkflowAuthority } from "@/lib/workflow-authorities";

export * from "@shared/workflow-automation.ts";
export type { AutomationCard } from "@/lib/core/automation-presentation";
export {
  AUTOMATION_STATE_KEYS,
  automationActionKey,
  automationCard,
  carryOverChoice,
  recommendedAutomationEnvironment,
} from "@/lib/core/automation-presentation";

export type AutomationInputs = SharedAutomationInputs<WorkflowAuthority>;
export type AutomationState = SharedAutomationState<WorkflowAuthority>;
