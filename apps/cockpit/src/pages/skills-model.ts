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

export const SKILL_TEMPLATES = ["tone", "report", "errors", "company"] as const;

export type SkillTemplate = (typeof SKILL_TEMPLATES)[number];

export function skillTemplateFromSearch(search: string): SkillTemplate | null {
  const value = new URLSearchParams(search).get("template") ?? "";
  return (SKILL_TEMPLATES as readonly string[]).includes(value) ? (value as SkillTemplate) : null;
}

export function skillTemplateKeys(template: SkillTemplate): {
  title: TranslationKey;
  line: TranslationKey;
  body: TranslationKey;
} {
  return {
    title: `skills.template.${template}.title`,
    line: `skills.template.${template}.line`,
    body: `skills.template.${template}.body`,
  };
}

export interface SkillHistoryEntry {
  audit_entry_id: string;
  version: number | null;
  title: string | null;
  lifecycle: string | null;
  updated_at: string;
  actor_id: string | null;
  has_snapshot: boolean;
}

export interface SkillVersionRow extends SkillHistoryEntry {
  current: boolean;
  restorable: boolean;
}

export function skillVersionRows(
  entries: readonly SkillHistoryEntry[],
  currentVersion: number,
): SkillVersionRow[] {
  const found = entries.findIndex((entry) => entry.version === currentVersion);
  const currentIndex = found < 0 ? 0 : found;
  return entries.map((entry, index) => ({
    ...entry,
    current: index === currentIndex,
    restorable: entry.has_snapshot && index !== currentIndex,
  }));
}
