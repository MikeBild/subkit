import type { TranslationKey } from "@/lib/i18n";

/** Where a skill applies, in the reader's words. */
export function skillScopeKey(scope: string): TranslationKey {
  if (scope === "connector") return "skills.scope.connector";
  if (scope === "workflow") return "skills.scope.workflow";
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
