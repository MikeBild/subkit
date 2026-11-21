import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

export type SkillAppliesTo = "chat" | "authoring" | "both";

export type SkillScope = "global" | "connector" | "template" | "workflow" | "unbound";

export function skillTemplates(skill: {
  activates_when?: readonly { kind: string; slug?: string }[] | null;
}): string[] {
  return (skill.activates_when ?? []).flatMap((entry) =>
    entry.kind === "connector_template" && typeof entry.slug === "string" ? [entry.slug] : [],
  );
}

export function skillScopeKey(scope: string): TranslationKey {
  if (scope === "connector") return "skills.scope.connector";
  if (scope === "template") return "skills.scope.template";
  if (scope === "workflow") return "skills.scope.workflow";
  if (scope === "unbound") return "skills.scope.unbound";
  return "skills.scope.global";
}

export type SkillsSummaryState = "loading" | "shown" | "hidden";

export const SKILL_TEMPLATES = ["tone", "report", "errors", "company"] as const;

export type SkillTemplate = (typeof SKILL_TEMPLATES)[number];

export type SkillHistoryEntry = components["schemas"]["SkillHistoryEntry"];

export type SkillVersionRow = SkillHistoryEntry & {
  current: boolean;
  restorable: boolean;
};

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

export function skillHistoryGap(
  rows: readonly SkillVersionRow[],
  currentVersion: number,
): { through: number } | null {
  const numbered = rows.flatMap((row) => (row.version === null ? [] : [row.version]));
  const oldest = numbered.length > 0 ? Math.min(...numbered) : currentVersion;
  return oldest > 1 ? { through: oldest - 1 } : null;
}

export type SkillHistoryDetail = components["schemas"]["SkillHistoryDetail"];
