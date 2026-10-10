import type { IntakeState } from "@/api/intake";
import type { TranslationKey } from "@/lib/i18n";

export const INTAKE_STATES = ["collected", "reviewing", "admitted", "discarded"] as const;
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
