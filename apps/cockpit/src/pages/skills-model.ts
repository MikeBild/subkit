import type { TranslationKey } from "@/lib/i18n";

export type SkillAppliesTo = "chat" | "authoring" | "both";

export const SKILL_APPLIES_TO: readonly SkillAppliesTo[] = ["chat", "authoring", "both"];

export function skillAppliesToOptionKey(appliesTo: SkillAppliesTo): TranslationKey {
  if (appliesTo === "chat") return "skills.editor.appliesTo.chat";
  if (appliesTo === "authoring") return "skills.editor.appliesTo.authoring";
  return "skills.editor.appliesTo.both";
}

export function skillScopeKey(scope: string, appliesTo: string = "both"): TranslationKey {
  if (scope === "connector") return "skills.scope.connector";
  if (scope === "workflow") return "skills.scope.workflow";
  if (appliesTo === "chat") return "skills.scope.chat";
  if (appliesTo === "authoring") return "skills.scope.authoring";
  return "skills.scope.global";
}

export function skillStateLabelKey(status: string): TranslationKey {
  if (status === "active") return "skills.state.active";
  if (status === "draft") return "skills.state.draft";
  return "skills.state.disabled";
}
