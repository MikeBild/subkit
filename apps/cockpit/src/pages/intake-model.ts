import type {
  CreateIntakeClipInput,
  IntakeOriginFilter,
  IntakeProposalTarget,
  IntakeSkillTarget,
  IntakeSnapshot,
  IntakeState,
} from "@/api/intake";
import type { TranslationKey } from "@/lib/i18n";
import { computeLineDiff, type FocusedRow, focusDiff } from "@/lib/line-diff";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const INTAKE_STATES = ["collected", "reviewing", "admitted", "discarded"] as const;
export const INTAKE_ORIGINS = ["clip", "note", "session"] as const;
export type IntakeOrigin = (typeof INTAKE_ORIGINS)[number];
export const INTAKE_AUTHORS = ["all", "ai"] as const;
export type IntakeAuthor = (typeof INTAKE_AUTHORS)[number];
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
  return snapshot.origin === "session" || snapshot.origin === "note" ? snapshot.origin : "clip";
}

export function intakeOriginLabelKey(
  origin: IntakeOrigin,
): "intake.origin.clip" | "intake.origin.note" | "intake.origin.session" {
  return `intake.origin.${origin}`;
}

export function intakeSourceUrl(snapshot: IntakeSnapshot): string | null {
  return "source_url" in snapshot ? (snapshot.source_url ?? null) : null;
}

export function isIntakeAuthor(value: string): value is IntakeAuthor {
  return (INTAKE_AUTHORS as readonly string[]).includes(value);
}

export function intakeAuthorOrigin(author: IntakeAuthor): IntakeOriginFilter | undefined {
  return author === "ai" ? "session" : undefined;
}

export function intakeNoteRequest(input: {
  clientRequestId: string;
  title: string;
  body: string;
  category: string;
  capturedAt: Date;
}): CreateIntakeClipInput | null {
  const title = input.title.trim();
  if (!title || !input.body.trim()) return null;
  return {
    client_request_id: input.clientRequestId,
    title,
    body: input.body,
    captured_at: input.capturedAt.toISOString(),
    ...(input.category ? { category: input.category } : {}),
  };
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

export type IntakeStripState = "new" | "proposal" | "changed" | "confirmed" | "discarded";

export function intakeStripState(
  clip: { state: IntakeState },
  proposals: readonly { status: string }[],
): IntakeStripState {
  if (clip.state === "discarded") return "discarded";
  if (clip.state === "admitted") return "confirmed";
  if (proposals.some((proposal) => proposal.status === "stale")) return "changed";
  if (proposals.some((proposal) => proposal.status === "draft")) return "proposal";
  return "new";
}

export const INTAKE_STRIP_TONE = {
  new: "info",
  proposal: "warn",
  changed: "warn",
  confirmed: "ok",
  discarded: "info",
} as const satisfies Record<IntakeStripState, "ok" | "info" | "warn" | "error">;

export type IntakeEventKind =
  | "collected"
  | "proposed"
  | "changed"
  | "confirmed"
  | "rejected"
  | "discarded";

export interface IntakeEvent {
  id: string;
  kind: IntakeEventKind;
  at: string;
  title?: string;
}

interface EventProposal {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  rejected_at: string | null;
  revision: { title: string };
}

export function intakeEvents(
  clip: { state: IntakeState; created_at: string; updated_at: string },
  proposals: readonly EventProposal[],
): IntakeEvent[] {
  const events: IntakeEvent[] = [{ id: "collected", kind: "collected", at: clip.created_at }];
  for (const proposal of proposals) {
    const title = proposal.revision.title;
    events.push({
      id: `${proposal.id}:proposed`,
      kind: "proposed",
      at: proposal.created_at,
      title,
    });
    if (proposal.status === "confirmed")
      events.push({
        id: `${proposal.id}:confirmed`,
        kind: "confirmed",
        at: proposal.updated_at,
        title,
      });
    if (proposal.status === "rejected")
      events.push({
        id: `${proposal.id}:rejected`,
        kind: "rejected",
        at: proposal.rejected_at ?? proposal.updated_at,
        title,
      });
    if (proposal.status === "stale")
      events.push({
        id: `${proposal.id}:changed`,
        kind: "changed",
        at: proposal.updated_at,
        title,
      });
  }
  if (clip.state === "discarded")
    events.push({ id: "discarded", kind: "discarded", at: clip.updated_at });
  return events.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}
