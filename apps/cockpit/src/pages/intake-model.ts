import type {
  IntakeProposalTarget,
  IntakeSkillTarget,
  IntakeSnapshot,
  IntakeState,
} from "@/api/intake";
import type { TranslationKey } from "@/lib/i18n";
import { computeLineDiff, type FocusedRow, focusDiff } from "@/lib/line-diff";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const INTAKE_STATES = ["collected", "reviewing", "admitted", "discarded"] as const;
export const INTAKE_ORIGINS = ["clip", "session"] as const;
export type IntakeOrigin = (typeof INTAKE_ORIGINS)[number];
export const INTAKE_CHAT_PROMPTS = ["review", "summarize", "compare", "prepare"] as const;
export type IntakeChatPrompt = (typeof INTAKE_CHAT_PROMPTS)[number];

export function intakeTargetTopic(
  category: string | undefined,
  tags: readonly string[] | undefined,
): string | null {
  if (category && category !== "other") return category;
  const domain = tags?.find((tag) => tag.startsWith("domain:") && tag.length > "domain:".length);
  return domain?.slice("domain:".length) ?? null;
}

export function intakeTargetDetails(
  category: string | undefined,
  tags: readonly string[] | undefined,
): { category: string | null; tags: string | null } {
  const value = category?.trim() || null;
  const selected = tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  return { category: value, tags: selected.length ? selected.join(", ") : null };
}

export function intakeStateLabelKey(
  state: IntakeState,
):
  | "intake.state.collected"
  | "intake.state.reviewing"
  | "intake.state.admitted"
  | "intake.state.discarded" {
  return `intake.state.${state}`;
}

export function isIntakeCategory(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 40 && value !== "platform";
}

export function intakeCategoryFromSearch(
  search: ConstructorParameters<typeof URLSearchParams>[0],
): string | "all" | null {
  const requested = new URLSearchParams(search).get("category");
  if (requested === "all") return "all";
  return requested && isIntakeCategory(requested) ? requested : null;
}

export function intakeChatPrompt(
  category: string,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  kind: IntakeChatPrompt = "review",
): string {
  const key: Record<IntakeChatPrompt, TranslationKey> = {
    review: "intake.chatPrompt",
    summarize: "intake.chatPromptSummarize",
    compare: "intake.chatPromptCompare",
    prepare: "intake.chatPromptPrepare",
  };
  return t(key[kind], { collection: category });
}

export function proposalMatchesVisibleItems(
  itemIds: readonly string[],
  visibleItemIds: ReadonlySet<string>,
  focusedId: string | null,
  proposalId: string,
): boolean {
  return proposalId === focusedId || itemIds.some((id) => visibleItemIds.has(id));
}

export function intakeNextAction(
  state: IntakeState,
): "review" | "openKnowledge" | "restore" | null {
  if (state === "collected" || state === "reviewing") return "review";
  if (state === "admitted") return "openKnowledge";
  if (state === "discarded") return "restore";
  return null;
}

export function publishedDate(
  value: string | undefined,
  format: (value: string) => string,
): string | null {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? value : format(value);
}

export function intakeItemChatPrompt(
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string {
  return t("intake.itemChatPrompt");
}

export function intakeOrigin(snapshot: Pick<IntakeSnapshot, "origin">): IntakeOrigin {
  return snapshot.origin === "session" ? "session" : "clip";
}

export function intakeOriginLabelKey(
  origin: IntakeOrigin,
): "intake.origin.clip" | "intake.origin.session" {
  return `intake.origin.${origin}`;
}

export type SessionSnapshot = Extract<IntakeSnapshot, { origin: "session" }>;

export function sessionSnapshot(snapshot: IntakeSnapshot): SessionSnapshot | null {
  return snapshot.origin === "session" ? snapshot : null;
}

export function sessionPlace(snapshot: Pick<SessionSnapshot, "repo" | "domains">): string | null {
  const parts = [snapshot.repo, ...snapshot.domains].filter((part): part is string =>
    Boolean(part?.trim()),
  );
  return parts.length ? parts.join(" · ") : null;
}

export function sessionLabel(id: string, t: Translate): string {
  const transcript = /^transcript-([0-9a-f]{8})[0-9a-f]{24}$/.exec(id);
  return transcript ? t("intake.session.transcript", { id: transcript[1] ?? "" }) : id;
}

export function isSkillTarget(target: IntakeProposalTarget): target is IntakeSkillTarget {
  return "skill" in target;
}

export function intakeConfirmPermissions(target: IntakeProposalTarget): string[] {
  if (!isSkillTarget(target)) return ["intake:confirm", "knowledge:write"];
  return [
    "intake:confirm",
    "skill:write",
    "skill:activate",
    ...(target.skill.supersedes.length ? ["skill:archive"] : []),
  ];
}

export function mayConfirmIntakeProposal(
  target: IntakeProposalTarget,
  permissions: readonly string[],
): boolean {
  return intakeConfirmPermissions(target).every((permission) => permissions.includes(permission));
}

export type ReferencedSkill = { title: string; version: number; body: string; status?: string };

type NewSkill = NonNullable<IntakeSkillTarget["skill"]["new"]>;

export function skillScopeLabel(
  created: Pick<NewSkill, "scope">,
  bindingName: string | null,
  t: Translate,
): string {
  if (created.scope === "connector")
    return t("intake.target.scopeConnector", { name: bindingName ?? "…" });
  if (created.scope === "workflow")
    return t("intake.target.scopeWorkflow", { name: bindingName ?? "…" });
  return t("intake.target.scopeGlobal");
}

export function skillTargetIds(target: IntakeSkillTarget): string[] {
  return [
    ...(target.skill.skill_id ? [target.skill.skill_id] : []),
    ...target.skill.supersedes.map((entry) => entry.skill_id),
  ];
}

export function newSkillLine(
  target: IntakeSkillTarget,
  t: Translate,
  bindingName: string | null = null,
): string | null {
  const created = target.skill.new;
  if (!created) return null;
  const domain = intakeTargetTopic(created.category, created.tags);
  const named = domain
    ? t("intake.target.newSkill", { title: created.title, domain })
    : t("intake.target.newSkillShared", { title: created.title });
  return `${named} · ${skillScopeLabel(created, bindingName, t)}`;
}

export function changedSkillLine(
  kind: "update" | "replace",
  skill: Pick<ReferencedSkill, "title" | "version"> | undefined,
  expectedVersion: number | undefined,
  t: Translate,
): string {
  const values = {
    skill: skill?.title ?? t("intake.target.selectedSkill"),
    version: expectedVersion ?? skill?.version ?? "?",
  };
  return t(kind === "update" ? "intake.target.updateSkill" : "intake.target.replacesSkill", values);
}

export function skillBodyChange(before: string, after: string): FocusedRow[] {
  return focusDiff(computeLineDiff(before.split("\n"), after.split("\n")));
}
