import type { TranslationKey } from "@/lib/i18n";

/** Where a skill is offered: the chat, workflow drafts, or both. */
export type SkillAppliesTo = "chat" | "authoring" | "both";

export const SKILL_APPLIES_TO: readonly SkillAppliesTo[] = ["chat", "authoring", "both"];

/** The editor's option label for one `applies_to` value. */
export function skillAppliesToOptionKey(appliesTo: SkillAppliesTo): TranslationKey {
  if (appliesTo === "chat") return "skills.editor.appliesTo.chat";
  if (appliesTo === "authoring") return "skills.editor.appliesTo.authoring";
  return "skills.editor.appliesTo.both";
}

/**
 * Where a skill applies, in the reader's words. A connector or workflow skill
 * is bound to that one record; a general skill names where it is offered.
 */
export function skillScopeKey(scope: string, appliesTo: string = "both"): TranslationKey {
  if (scope === "connector") return "skills.scope.connector";
  if (scope === "workflow") return "skills.scope.workflow";
  if (appliesTo === "chat") return "skills.scope.chat";
  if (appliesTo === "authoring") return "skills.scope.authoring";
  return "skills.scope.global";
}

/**
 * A skill's lifecycle as a reader says it: the engine archives a skill to
 * switch it off, so "archived" reads "Deaktiviert".
 */
export function skillStateLabelKey(status: string): TranslationKey {
  if (status === "active") return "skills.state.active";
  if (status === "draft") return "skills.state.draft";
  return "skills.state.disabled";
}
