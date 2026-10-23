import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";
import { computeLineDiff, type FocusedRow, focusDiff } from "@/lib/line-diff";

export type SkillAppliesTo = "chat" | "authoring" | "both";

export const SKILL_APPLIES_TO: readonly SkillAppliesTo[] = ["chat", "authoring", "both"];

export function skillAppliesToOptionKey(appliesTo: SkillAppliesTo): TranslationKey {
  if (appliesTo === "chat") return "skills.editor.appliesTo.chat";
  if (appliesTo === "authoring") return "skills.editor.appliesTo.authoring";
  return "skills.editor.appliesTo.both";
}

export type SkillScope = "global" | "connector" | "workflow" | "unbound";

export function skillScope(skill: {
  scope: string;
  connector_id?: string | null;
  workflow_id?: string | null;
}): SkillScope {
  if (skill.scope === "connector") return skill.connector_id ? "connector" : "unbound";
  if (skill.scope === "workflow") return skill.workflow_id ? "workflow" : "unbound";
  return "global";
}

export function skillScopeKey(scope: string): TranslationKey {
  if (scope === "connector") return "skills.scope.connector";
  if (scope === "workflow") return "skills.scope.workflow";
  if (scope === "unbound") return "skills.scope.unbound";
  return "skills.scope.global";
}

export function skillScopePhraseKey(scope: SkillScope): TranslationKey {
  if (scope === "connector") return "skills.scopePhrase.connector";
  if (scope === "workflow") return "skills.scopePhrase.workflow";
  if (scope === "unbound") return "skills.scopePhrase.unbound";
  return "skills.scopePhrase.global";
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

export function skillVersionBasis(
  rows: readonly SkillVersionRow[],
  row: SkillVersionRow,
): number | null {
  if (row.version === null || row.version <= 1) return null;
  const previous = row.version - 1;
  return rows.some((entry) => entry.version === previous) ? previous : null;
}

export function skillHistoryGap(
  rows: readonly SkillVersionRow[],
  currentVersion: number,
): { through: number } | null {
  const numbered = rows.flatMap((row) => (row.version === null ? [] : [row.version]));
  const oldest = numbered.length > 0 ? Math.min(...numbered) : currentVersion;
  return oldest > 1 ? { through: oldest - 1 } : null;
}

export function skillChangedAt(
  skill: { version: number; updated_at: string },
  rows: readonly SkillVersionRow[] | null,
): string {
  const current = rows?.find((row) => row.version === skill.version);
  return current?.updated_at ?? skill.updated_at;
}

export type SkillHistoryDetail = components["schemas"]["SkillHistoryDetail"];

export interface SkillVersionChange {
  rows: FocusedRow[];
  renamedFrom: string | null;
}

export function skillVersionChange(detail: SkillHistoryDetail): SkillVersionChange | null {
  if (!detail.before || !detail.after) return null;
  return {
    rows: focusDiff(computeLineDiff(detail.before.body.split("\n"), detail.after.body.split("\n"))),
    renamedFrom: detail.before.title === detail.after.title ? null : detail.before.title,
  };
}
