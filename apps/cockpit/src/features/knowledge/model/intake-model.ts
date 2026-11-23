import type {
  CreateIntakeClipInput,
  IntakeProposalTarget,
  IntakeSkillTarget,
  IntakeSnapshot,
  IntakeState,
} from "@/api/intake";
import type { AssistantMarkKind } from "@/features/connectors";
import type { Translate } from "@/lib/i18n";
import { computeLineDiff, type FocusedRow, focusDiff } from "@/lib/line-diff";

export const INTAKE_STATES = ["collected", "reviewing", "admitted", "discarded"] as const;
export const INTAKE_ORIGINS = ["clip", "note", "session"] as const;
export type IntakeOrigin = (typeof INTAKE_ORIGINS)[number];
export const INTAKE_CHAT_PROMPTS = ["review", "summarize", "compare", "prepare"] as const;

export function intakeTargetTopic(
  category: string | undefined,
  tags: readonly string[] | undefined,
): string | null {
  if (category && category !== "other") return category;
  const domain = tags?.find((tag) => tag.startsWith("domain:") && tag.length > "domain:".length);
  return domain?.slice("domain:".length) ?? null;
}

export function isIntakeCategory(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 40 && value !== "platform";
}

export function publishedDate(
  value: string | undefined,
  format: (value: string) => string,
): string | null {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? value : format(value);
}

export function intakeOrigin(snapshot: Pick<IntakeSnapshot, "origin">): IntakeOrigin {
  return snapshot.origin === "session" || snapshot.origin === "note" ? snapshot.origin : "clip";
}

export function intakeOriginLabelKey(
  origin: IntakeOrigin,
): "intake.origin.clip" | "intake.origin.note" | "intake.origin.session" {
  return `intake.origin.${origin}`;
}

interface IntakeAssistant {
  mark: AssistantMarkKind;
  name: string | null;
}

const UNNAMED_ASSISTANTS = new Set(["save_learning", "session", "create_skill", "mcp"]);

function namedAssistant(raw: string): IntakeAssistant | null {
  const name = raw.trim();
  const key = name.toLowerCase();
  if (!key || UNNAMED_ASSISTANTS.has(key)) return null;
  if (/claude[\s_-]*code/.test(key)) return { mark: "claude", name: "Claude Code" };
  if (key.startsWith("claude")) return { mark: "claude", name: "Claude" };
  if (key.includes("codex")) return { mark: "codex", name: "Codex" };
  if (key === "chat") return { mark: "subkit", name: null };
  return { mark: "bot", name };
}

export function intakeAssistant(
  snapshot: Pick<SessionSnapshot, "agent" | "client">,
): IntakeAssistant {
  for (const raw of [snapshot.client, snapshot.agent]) {
    const named = raw ? namedAssistant(raw) : null;
    if (named) return named;
  }
  return { mark: "bot", name: null };
}

export function intakeAssistantLabel(assistant: IntakeAssistant, t: Translate): string {
  if (assistant.mark === "subkit") return t("intake.assistant.chat");
  return assistant.name ?? t("intake.origin.session");
}

type ReviewableClip = { state: IntakeState; original_snapshot: Pick<IntakeSnapshot, "origin"> };

export function intakeNeedsAssistantReview(clip: ReviewableClip): boolean {
  return (
    intakeOrigin(clip.original_snapshot) === "session" &&
    (clip.state === "collected" || clip.state === "reviewing")
  );
}

export function intakeConversationId(
  snapshot: Pick<SessionSnapshot, "agent" | "client" | "session_id">,
): string | null {
  const chat =
    snapshot.client === "chat" || (!snapshot.client && snapshot.agent === "save_learning");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return chat && uuid.test(snapshot.session_id) ? snapshot.session_id : null;
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

type SessionSnapshot = Extract<IntakeSnapshot, { origin: "session" }>;

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

type SkillRule = NonNullable<IntakeSkillTarget["skill"]["rules"]>[number];

export type ReferencedSkill = {
  title: string;
  version: number;
  body: string;
  status?: string;
  rules?: SkillRule[];
  domains?: string[];
};

type SkillConventionsView = { rules: string[]; domains: string };

function ruleLine(rule: SkillRule): string {
  const payload = Object.entries(rule.payload)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  return `${rule.rule_id} · ${rule.type}: ${rule.statement} (${payload})`;
}

export function skillConventionsView(
  target: IntakeSkillTarget,
  existing: Pick<ReferencedSkill, "rules" | "domains"> | undefined,
  t: Translate,
): SkillConventionsView | null {
  const { rules, domains } = target.skill;
  if (rules === undefined && domains === undefined) return null;
  const effectiveDomains = domains ?? existing?.domains ?? [];
  return {
    rules: (rules ?? existing?.rules ?? []).map(ruleLine),
    domains: effectiveDomains.length
      ? effectiveDomains.join(", ")
      : t("intake.proposal.ruleDomainsEverywhere"),
  };
}

type NewSkill = NonNullable<IntakeSkillTarget["skill"]["new"]>;

function skillScopeLabel(
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

export type IntakeEventKind =
  | "collected"
  | "proposed"
  | "changed"
  | "confirmed"
  | "rejected"
  | "discarded";

interface IntakeEvent {
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

export type IntakeWriteFailureKey =
  | "intake.proposal.confirmConflict"
  | "intake.proposal.secondPersonRequired"
  | "common.actionFailed";

export function intakeWriteFailureKey(error: unknown): IntakeWriteFailureKey {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  if (record.code === "second_person_required") return "intake.proposal.secondPersonRequired";
  if (record.status === 409) return "intake.proposal.confirmConflict";
  return "common.actionFailed";
}
