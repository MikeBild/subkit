import type { TranslationKey } from "@/lib/i18n";

export type SkillAppliesTo = "chat" | "authoring" | "both";

export const SKILL_APPLIES_TO: readonly SkillAppliesTo[] = ["chat", "authoring", "both"];

export function skillAppliesToOptionKey(appliesTo: SkillAppliesTo): TranslationKey {
  if (appliesTo === "chat") return "skills.editor.appliesTo.chat";
  if (appliesTo === "authoring") return "skills.editor.appliesTo.authoring";
  return "skills.editor.appliesTo.both";
}

export function skillScopeKey(scope: string): TranslationKey {
  if (scope === "connector") return "skills.scope.connector";
  if (scope === "workflow") return "skills.scope.workflow";
  return "skills.scope.global";
}

export function skillWhereKey(appliesTo: string | null | undefined): TranslationKey {
  if (appliesTo === "chat") return "skills.where.chat";
  if (appliesTo === "authoring") return "skills.where.authoring";
  return "skills.where.both";
}

export function skillStateLabelKey(status: string): TranslationKey {
  if (status === "active") return "skills.state.active";
  if (status === "draft") return "skills.state.draft";
  return "skills.state.disabled";
}

type ListQueryState = { isPending: boolean; error: unknown; failureReason: unknown };

export function skillsLoadState(queries: readonly ListQueryState[]): {
  pending: boolean;
  failed: boolean;
} {
  const failed = queries.some((query) => Boolean(query.error || query.failureReason));
  return { pending: !failed && queries.some((query) => query.isPending), failed };
}
